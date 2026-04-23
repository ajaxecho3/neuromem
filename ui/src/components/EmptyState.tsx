export function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-gray-400 dark:text-gray-500">
      <div className="text-5xl mb-4">🧠</div>
      <p className="text-sm">{message}</p>
    </div>
  );
}
