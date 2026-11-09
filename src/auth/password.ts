import { hash, verify } from "@node-rs/argon2";

// argon2id is the library default (the `Algorithm` const enum can't be used
// with verbatimModuleSyntax). OWASP-recommended parameters: 19 MiB, 2
// iterations, 1 lane. Tests assert the stored hash starts with $argon2id$.
const options = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export const hashPassword = (password: string) => hash(password, options);

export const verifyPassword = (passwordHash: string, password: string) =>
  verify(passwordHash, password);

let dummyHash: Promise<string> | undefined;

/**
 * Runs a full argon2 verification against a throwaway hash. Login calls this
 * when the email is unknown, so the response takes as long as a wrong password
 * and timing doesn't reveal which emails are registered.
 */
export const verifyAgainstDummyHash = async (password: string) => {
  dummyHash ??= hashPassword("paybridge-dummy-password");
  await verify(await dummyHash, password);
  return false;
};
