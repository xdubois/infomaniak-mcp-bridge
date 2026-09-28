// Local testing without the Infomaniak login: enrols a fake user with the given API token in the
// configured store and mints a 1h bridge access token for it (printed on stdout).
// Usage: npx tsx scripts/dev-token.ts [infomaniak-api-token]     |     npx tsx scripts/dev-token.ts --remove
import {loadConfig} from "../src/config.js";
import {encrypt, randomToken, sha256} from "../src/crypto.js";
import {loadDotEnv} from "../src/env.js";
import {createStore} from "../src/store/index.js";
import {Repo} from "../src/store/repo.js";

loadDotEnv();
const cfg = loadConfig();
const store = await createStore(cfg);
const repo = new Repo(store);
const USER_ID = "dev-local";

if (process.argv[2] === "--remove") {
    await store.del("user", USER_ID);
    console.error("removed dev-local user (its access tokens expire on their own)");
} else {
    const apiToken = process.argv[2] ?? "dummy-api-token";
    await repo.putUser({id: USER_ID, email: "dev@localhost", apiTokenEnc: encrypt(apiToken, cfg.encryptionKey), enrolledAt: Date.now()});
    const access = randomToken(32);
    const now = Math.floor(Date.now() / 1000);
    await repo.putToken(sha256(access), {kind: "access", clientId: "dev", userId: USER_ID, scopes: [], expiresAt: now + 3600}, 3600);
    console.log(access);
}
await store.close();
