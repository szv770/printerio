const TONE_CLASSES = {
  neutral: "bg-gray-100 text-gray-700",
  success: "bg-green-100 text-green-800",
  warning: "bg-yellow-100 text-yellow-800",
  danger: "bg-red-100 text-red-800",
} as const;

export function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: keyof typeof TONE_CLASSES }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]}`}>
      {children}
    </span>
  );
}
