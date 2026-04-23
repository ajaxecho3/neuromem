import { useQuery } from "@tanstack/react-query";
import { getCognitionLog } from "../api/cognition";
import { ErrorBanner } from "../components/ErrorBanner";
import { EmptyState } from "../components/EmptyState";

export function CognitionLog() {
  const { data, error } = useQuery({
    queryKey: ["cognition-log"],
    queryFn: getCognitionLog,
    refetchInterval: 60_000,
  });

  return (
    <div>
      <h1 className="font-display text-2xl text-foreground mb-1">
        Cognition Log
      </h1>
      <p className="text-sm text-muted-foreground mb-4">
        Background loop activity — refreshes every 60s
      </p>

      <ErrorBanner error={error as Error | null} />

      {data && data.length === 0 && (
        <EmptyState message="No cognition cycles recorded yet." />
      )}

      {data && data.length > 0 && (
        <div className="space-y-3">
          {data.map((entry) => (
            <div
              key={entry.id}
              className="bg-card rounded-lg border border-border p-4"
            >
              <div className="text-xs text-muted-foreground font-mono mb-1">
                {new Date(entry.timestamp).toLocaleString()}
              </div>
              <div className="text-sm text-foreground/80">{entry.content}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
