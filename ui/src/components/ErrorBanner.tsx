export function ErrorBanner({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <div className="rounded bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 px-4 py-3 text-sm mb-4">
      {error.message}
    </div>
  );
}
