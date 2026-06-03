/** Read an environment variable via `Bun.env`, treating an empty string as unset. */
export const readEnv = (name: string): string | undefined => {
  const value = Bun.env[name];
  return value === undefined || value === '' ? undefined : value;
};

/** Read a finite numeric environment variable, or `fallback` when unset or invalid. */
export const readEnvNumber = (name: string, fallback: number): number => {
  const value = readEnv(name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
