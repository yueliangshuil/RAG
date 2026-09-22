-- 001_init.sql
-- 在 Supabase SQL Editor 中执行：启用 pgvector，创建会话/消息/文档/分块表

create extension if not exists vector;

-- 会话表（滚动摘要字段 summary 供分层记忆模块写入）
create table if not exists sessions (
  id         uuid primary key default gen_random_uuid(),
  title      text not null default '新对话',
  summary    text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 消息表
create table if not exists messages (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  role       text not null check (role in ('user', 'assistant')),
  content    text not null,
  sources    jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_messages_session on messages(session_id, created_at);

-- 文档表（content_hash 用于增量更新去重）
create table if not exists documents (
  id           uuid primary key default gen_random_uuid(),
  filename     text not null,
  file_type    text not null,
  content_hash text not null,
  chunk_count  integer not null default 0,
  created_at   timestamptz not null default now()
);
create unique index if not exists idx_documents_hash on documents(content_hash);

-- 分块表（embedding 维度 1024，对应 BGE-M3）
create table if not exists chunks (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  content     text not null,
  chunk_index integer not null,
  embedding   vector(1024),
  created_at  timestamptz not null default now()
);
create index if not exists idx_chunks_document on chunks(document_id);

-- 向量相似度检索函数
create or replace function match_chunks (
  query_embedding vector(1024),
  match_count int default 5
) returns table (
  id uuid,
  document_id uuid,
  content text,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select c.id, c.document_id, c.content, 1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  where c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- RLS：demo 阶段对 anon 全开放（数据访问全部走服务端 API Route + service_role key，
-- anon 策略仅为兜底；接入用户体系后收紧）
alter table sessions  enable row level security;
alter table messages  enable row level security;
alter table documents enable row level security;
alter table chunks    enable row level security;

create policy "anon_all_sessions"  on sessions  for all using (true) with check (true);
create policy "anon_all_messages"  on messages  for all using (true) with check (true);
create policy "anon_all_documents" on documents for all using (true) with check (true);
create policy "anon_all_chunks"    on chunks    for all using (true) with check (true);
