import { fixtureBytes, fixtureHash, fixtureNames } from '../lib/extraction/fixtures';

// Prints what a developer needs to paste into the .http file / curl script.
console.table(
  fixtureNames.map((name) => ({
    name,
    sha256: fixtureHash(name),
    content: fixtureBytes(name).toString('utf8'),
    base64: fixtureBytes(name).toString('base64'),
  })),
);
