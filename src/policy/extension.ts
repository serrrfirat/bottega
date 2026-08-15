export interface BottegaExtension {
  name: string;
}

/**
 * OMP extension factory (Slice 2).
 * Stub: returns a named extension with no tools yet.
 */
export function createExtension(): BottegaExtension {
  return { name: "bottega" };
}

if (import.meta.main) {
  console.log("bottega extension stub:", JSON.stringify(createExtension()));
}
