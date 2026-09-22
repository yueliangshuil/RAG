-- 002_hybrid_search_and_memory.sql
-- Phase 2：BM25+向量混合检索（RRF 融合）与分层记忆（消息向量记忆表）

-- ============ 1. 混合检索：chunks 增加 bigram 与 tsvector ============

alter table chunks add column if not exists bigrams text;

-- tsvector 由 bigrams 生成列自动维护，与 GIN 索引配合做关键词检索
alter table chunks add column if not exists tokens tsvector
  generated always as (to_tsvector('simple', bigrams)) stored;

create index if not exists idx_chunks_tokens on chunks using gin (tokens);

-- RRF（Reciprocal Rank Fusion）混合检索：
-- 向量相似度与 BM25 关键词各自排名，按 1/(k+rank) 融合，避免两种分数量纲不一致的问题
create or replace function hybrid_search (
  query_embedding vector(1024),
  query_tsquery tsquery,
  match_count int default 8,
  k int default 60
) returns table (
  id uuid,
  document_id uuid,
  content text,
  similarity float,
  rrf_score float
)
language sql
as $$
  with vec_ranked as (
    select id, row_number() over (order by embedding <=> query_embedding) as rnk
    from chunks
    where embedding is not null
  ),
  bm25_ranked as (
    select id, row_number() over (order by ts_rank(tokens, query_tsquery) desc) as rnk
    from chunks
    where tokens @@ query_tsquery
  )
  select
    c.id,
    c.document_id,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity,
    coalesce(1.0 / (k + v.rnk), 0) + coalesce(1.0 / (k + b.rnk), 0) as rrf_score
  from chunks c
  left join vec_ranked v on v.id = c.id
  left join bm25_ranked b on b.id = c.id
  where v.rnk is not null or b.rnk is not null
  order by rrf_score desc
  limit match_count;
$$;

-- ============ 2. 分层记忆：消息向量记忆表 ============

-- 滚动摘要进度：已折叠进摘要的消息数，用于判断何时触发下一次压缩
alter table sessions add column if not exists summarized_upto int not null default 0;

create table if not exists message_memories (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  message_id uuid not null references messages(id) on delete cascade,
  role       text not null check (role in ('user', 'assistant')),
  content    text not null,
  embedding  vector(1024),
  created_at timestamptz not null default now()
);

create index if not exists idx_memories_session on message_memories(session_id, created_at);

-- 按当前问题检索相关历史记忆（过滤相似度过低的噪声）
create or replace function match_memories (
  query_embedding vector(1024),
  sid uuid,
  match_count int default 6,
  min_similarity float default 0.4
) returns table (
  message_id uuid,
  role text,
  content text,
  similarity float
)
language sql
as $$
  select m.message_id, m.role, m.content, 1 - (m.embedding <=> query_embedding) as similarity
  from message_memories m
  where m.session_id = sid
    and m.embedding is not null
    and 1 - (m.embedding <=> query_embedding) >= min_similarity
  order by m.embedding <=> query_embedding
  limit match_count;
$$;
