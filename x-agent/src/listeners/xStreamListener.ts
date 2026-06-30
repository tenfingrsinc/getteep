/**
 * Filtered stream listener (production).
 * Enable with X_USE_FILTERED_STREAM=true once X API tier supports it.
 */
export async function startFilteredStream(_onPost: (post: unknown) => Promise<void>) {
  throw new Error(
    "Filtered stream is not enabled yet. Set X_USE_FILTERED_STREAM=false and use polling, or implement stream rules for your X API tier."
  );
}
