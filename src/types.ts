/** Output shape written to data/malicious/{ecosystem}.json */
export interface EcosystemOutput {
  /** Packages where all versions are affected */
  maliciousPackages: string[];
  /** Packages with specific affected versions: { [name]: versions[] } */
  maliciousVersions: Record<string, string[]>;
}

/** Combined malicious DB: all ecosystems in a single file */
export type MaliciousDb = Record<string, EcosystemOutput>;
