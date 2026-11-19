import { SkeletonHeader, SkeletonRows } from "@/components/ui";

export default function Loading() {
  return (
    <div>
      <SkeletonHeader />
      <SkeletonRows rows={3} />
    </div>
  );
}
