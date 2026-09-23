-- 006_document_versioning.sql
-- 文档版本化（约束感知 Agent 项目要求：规则变更可追溯）
-- 同文件名重新上传且内容变化 → 新版本插入，旧版本 is_latest=false；检索只查最新版

alter table documents add column if not exists version integer not null default 1;
alter table documents add column if not exists is_latest boolean not null default true;

create index if not exists idx_documents_filename on documents(filename, is_latest);

-- 检索函数更新：只检索最新版本文档的分块
create or replace function match_chunks (
  query_embedding vector(1024),
  match_count int default 5
) returns table (
  id uuid,
  document_id uuid,
  content text,
  similarity float
)
language sql
as $$
  select c.id, c.document_id, c.content, 1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  join documents d on d.id = c.document_id and d.is_latest
  where c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function hybrid_search (
  query_embedding vector(1024),
  query_tsquery tsquery,
  match_count int default 8,
  k int default 60,
  vec_weight float default 1.0,
  bm25_weight float default 0.5
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
    select c.id, row_number() over (order by c.embedding <=> query_embedding) as rnk
    from chunks c
    join documents d on d.id = c.document_id and d.is_latest
    where c.embedding is not null
  ),
  bm25_ranked as (
    select c.id, row_number() over (order by ts_rank(c.tokens, query_tsquery) desc) as rnk
    from chunks c
    join documents d on d.id = c.document_id and d.is_latest
    where c.tokens @@ query_tsquery
  )
  select
    c.id,
    c.document_id,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity,
    coalesce(1.0 / (k + v.rnk), 0) * vec_weight
      + coalesce(1.0 / (k + b.rnk), 0) * bm25_weight as rrf_score
  from chunks c
  left join vec_ranked v on v.id = c.id
  left join bm25_ranked b on b.id = c.id
  where v.rnk is not null or b.rnk is not null
  order by rrf_score desc
  limit match_count;
$$;
