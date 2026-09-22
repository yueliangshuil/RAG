/**
 * 防抖工具（trailing 语义）：在连续调用停止 wait 毫秒后才执行最后一次。
 * 用于服务端流式内容的 DB 落库——避免每个 chunk 都写库，
 * 静默 500ms 后才持久化一次；flush 用于流结束时立即落盘。
 */
export interface DebouncedFn<T extends (...args: never[]) => void> {
  (...args: Parameters<T>): void;
  /** 立即执行并清除等待中的调用（流结束时调用） */
  flush: (...args: Parameters<T>) => void;
  /** 取消等待中的调用 */
  cancel: () => void;
}

export function debounce<T extends (...args: never[]) => void>(fn: T, wait: number): DebouncedFn<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const debounced = (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };

  debounced.flush = (...args: Parameters<T>) => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    fn(...args);
  };

  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return debounced;
}
