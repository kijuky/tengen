/** Output shape written to data/malicious/{ecosystem}.json */
export interface EcosystemOutput {
  /** Packages where all versions are affected */
  maliciousPackages: string[];
  /** Packages with specific affected versions: { [name]: versions[] } */
  maliciousVersions: Record<string, string[]>;
}

/** Combined malicious DB: all ecosystems in a single file */
export type MaliciousDb = Record<string, EcosystemOutput>;

/** Per-ecosystem allowlist that exempts entries from the age-delay filter */
export interface EcosystemAllowlist {
  /** Packages whose every version bypasses the age filter */
  allowlistedPackages: string[];
  /** Packages with specific versions that bypass the age filter */
  allowlistedVersions: Record<string, string[]>;
}

/** Combined allowlist DB: all ecosystems in a single file */
export type AllowlistDb = Record<string, EcosystemAllowlist>;
