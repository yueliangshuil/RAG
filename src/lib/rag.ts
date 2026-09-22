import { createHash } from "crypto";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { extractText } from "unpdf";
import { getSupabaseAdmin } from "./supabase";
import { getEmbeddings } from "./llm";
import { bigramTokenize } from "./tokenizer";

export interface IngestResult {
  duplicated: boolean;
  documentId?: string;
  chunkCount?: number;
}

/**
 * 文档入库链路：解析 → 清洗 → 递归分块 → 嵌入 → 入库
 * - 内容哈希去重：相同文档（内容哈希一致）直接跳过，实现增量更新
 * - 中文分隔符优先级切割，缓解文本截断与语义断裂
 */
export async function ingestDocument(buffer: Buffer, filename: string): Promise<IngestResult> {
  // 1. 内容哈希去重
  const hash = createHash("sha256").update(buffer).digest("hex");
  const db = getSupabaseAdmin();
  const { data: existing } = await db
    .from("documents")
    .select("id")
    .eq("content_hash", hash)
    .maybeSingle();
  if (existing) return { duplicated: true };

  // 2. 文件解析（PDF / Markdown / 纯文本）
  const fileType = filename.split(".").pop()?.toLowerCase() ?? "txt";
  let text: string;
  if (fileType === "pdf") {
    const result = await extractText(new Uint8Array(buffer));
    const raw = Array.isArray(result.text) ? result.text.join("\n") : result.text;
    text = (raw ?? "").replace(/\x00/g, "");
  } else {
    text = buffer.toString("utf-8").replace(/\x00/g, "");
  }
  if (!text.trim()) {
    throw new Error("未能从文件中提取到文本内容（扫描版 PDF 需要先 OCR）");
  }

  // 3. 递归字符分割：段落/句子多级分隔符 + 固定块大小 + 重叠窗口
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 500,
    chunkOverlap: 50,
    separators: ["\n\n", "\n", "。", "！", "？", "；", "，", " ", ""],
  });
  const chunks = await splitter.splitText(text);
  if (chunks.length === 0) throw new Error("文档分块结果为空");

  // 4. 嵌入（BGE-M3，1024 维）
  const vectors = await getEmbeddings().embedDocuments(chunks);

  // 5. 入库（文档记录 + 分块批量写入，pgvector 以 JSON 字符串传入）
  const { data: doc, error: docError } = await db
    .from("documents")
    .insert({ filename, file_type: fileType, content_hash: hash, chunk_count: chunks.length })
    .select()
    .single();
  if (docError || !doc) {
    throw new Error(`文档记录写入失败: ${docError?.message ?? "未知错误"}`);
  }

  const rows = chunks.map((content, i) => ({
    document_id: doc.id,
    content,
    chunk_index: i,
    embedding: JSON.stringify(vectors[i]),
    // BM25 关键词检索：中文 bigram + 英文单词，供生成列 to_tsvector 使用
    bigrams: bigramTokenize(content).join(" "),
  }));
  const BATCH_SIZE = 30;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const { error: chunkError } = await db
      .from("chunks")
      .insert(rows.slice(i, i + BATCH_SIZE));
    if (chunkError) throw new Error(`分块写入失败: ${chunkError.message}`);
  }

  return { duplicated: false, documentId: doc.id, chunkCount: chunks.length };
}
