export type DataErrorKind = "network" | "format" | "missing" | "region";

/**
 * Every failure in data/ is a DataError naming the file involved (data/ §6).
 * network: the UI offers a retry. format / missing: a bug or a bad build; shown
 * in the console with the path. region: a caller sampled the DEM before
 * awaiting ensureRegion(), which is a programming error, not a fallback case.
 */
export class DataError extends Error {
  readonly kind: DataErrorKind;
  readonly path: string;

  constructor(kind: DataErrorKind, path: string, detail: string) {
    super(`[${kind}] ${path}: ${detail}`);
    this.name = "DataError";
    this.kind = kind;
    this.path = path;
  }
}
