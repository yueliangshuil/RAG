-- 004_drop_old_hybrid.sql
-- 003 用 create or replace 新增了带权重参数的 hybrid_search，
-- 但因参数签名不同，旧版（4 参）函数未被替换，导致同名重载调用歧义。
-- 这里显式删除旧签名，只保留带权重的版本。

drop function if exists hybrid_search(vector, tsquery, integer, integer);
