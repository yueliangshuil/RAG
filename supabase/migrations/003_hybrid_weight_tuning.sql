-- 003_hybrid_weight_tuning.sql
-- RRF 权重调优：等权融合时 BM25 噪声文档会挤掉正确的向量结果
-- （评测发现"新员工入职培训多久"被干扰文档的培训章节顶掉）
-- 调为向量 1.0 / BM25 0.5：向量为主信号，BM25 作增强与兜底

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
    coalesce(1.0 / (k + v.rnk), 0) * vec_weight
      + coalesce(1.0 / (k + b.rnk), 0) * bm25_weight as rrf_score
  from chunks c
  left join vec_ranked v on v.id = c.id
  left join bm25_ranked b on b.id = c.id
  where v.rnk is not null or b.rnk is not null
  order by rrf_score desc
  limit match_count;
$$;
