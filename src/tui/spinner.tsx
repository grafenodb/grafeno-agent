import { Text } from "ink";
import { useEffect, useState, type ReactNode } from "react";
import { SPINNER, theme } from "./theme.js";

/** A turning mark, for what is under way. */
export function Spinner(): ReactNode {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER.length);
    }, 90);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return <Text color={theme.accent}>{SPINNER[frame]}</Text>;
}
