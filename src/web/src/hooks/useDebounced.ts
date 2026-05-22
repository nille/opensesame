import { useEffect, useState } from "react";

// Debounce a rapidly-changing value. The debounced result trails the source
// by `delay` ms of quiescence — typing keeps resetting the timer.

export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}
