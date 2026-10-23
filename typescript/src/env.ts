/** Reads one environment variable. An empty value reads as unset. */
export type EnvReader = (name: string) => string | undefined;

type ProcessLike = { env?: Record<string, string | undefined> };

/** The process environment where the platform has one. A read the platform refuses, as Deno
 *  does without `--allow-env`, reads as unset. */
export const readProcessEnv: EnvReader = (name) => {
  try {
    const value = (globalThis as { process?: ProcessLike }).process?.env?.[name];
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
};

/** An environment reader over a fixed set of variables, with empty values read as unset. */
export const envFrom =
  (variables: Readonly<Record<string, string>>): EnvReader =>
  (name) =>
    Object.hasOwn(variables, name) && variables[name] !== "" ? variables[name] : undefined;
