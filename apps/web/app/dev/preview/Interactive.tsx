"use client";

import { useState } from "react";
import { Segmented } from "@/components/ui";

export function SegmentedDemo() {
  const [v, setV] = useState<"left" | "right">("left");
  return (
    <Segmented
      label="Binding side"
      value={v}
      onChange={setV}
      options={[
        { value: "left", label: "Left" },
        { value: "right", label: "Right" },
      ]}
    />
  );
}
