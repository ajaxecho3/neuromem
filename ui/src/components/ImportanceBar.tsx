import { cn } from "@/lib/utils";

function getColor(value: number) {
  if (value >= 0.8) return "bg-emerald-500";
  if (value >= 0.6) return "bg-blue-500";
  if (value >= 0.4) return "bg-yellow-400";
  if (value >= 0.2) return "bg-orange-400";
  return "bg-red-500";
}

export function ImportanceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);

  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", getColor(value))}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs font-ibm-mono text-gray-500 dark:text-gray-400">
        {value.toFixed(2)}
      </span>
    </div>
  );
}
