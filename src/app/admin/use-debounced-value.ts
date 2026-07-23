import { useEffect, useState } from "react";

export function useDebouncedValue(value: string): string {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebouncedValue(value), 250);
    return () => window.clearTimeout(timeoutId);
  }, [value]);

  return debouncedValue;
}
