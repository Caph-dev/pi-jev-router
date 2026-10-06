# Releasing

Maintainer notes. Nothing here is needed to *use* the package.

## One-time setup

npm refuses to accept a publish from a plain login token — it demands either an account with 2FA
(a browser prompt on every publish) or a granular access token with **Bypass two-factor
authentication** enabled. The token is the quieter option:

1. Open https://www.npmjs.com/settings/caph42/tokens → **Generate New Token** → **Granular Access
   Token**.
2. **Packages and scopes**: `All packages in @caph42` (or just `@caph42/pi-jev-router`) with
   permission **Read and write**.
3. Check **Bypass two-factor authentication**. Without it, `npm publish` fails with
   `403 ... Two-factor authentication or granular access token with bypass 2fa enabled is required`.
4. **Expiration**: as long as the form allows. When it lapses, publishes fail with `401`/`403` —
   generate a new token.
5. Put it in `~/.npmrc` (this file is in `.gitignore`; never commit it):

   ```ini
   //registry.npmjs.org/:_authToken=npm_xxxxxxxxxxxxxxxx
   ```

Do **not** run `npm logout` while a granular token sits in `~/.npmrc` — it revokes the token in use,
including the new one. To drop an older session token, delete it from the token list on npmjs.com
instead.

## Release checklist

```sh
cd ~/Workspace/pi-packages/pi-jev-router

git status --short          # must be clean
git pull                    # stay in sync with origin
npm pack --dry-run          # name, version, and the 5 files that make up the tarball
npm version patch           # or minor / major — see below
git push --follow-tags
npm publish --access public # no browser prompt once the token above is in place
```

Before bumping, check that the docs kept up with the code: new or renamed config keys belong in the
README table *and* in `jev-router.example.json`.

## Verify the release

```sh
npm view @caph42/pi-jev-router version dist-tags dist.tarball

# the published tarball must be byte-identical to the local build
npm pack --dry-run | grep shasum
cd /tmp && npm pack @caph42/pi-jev-router && tar tzf caph42-pi-jev-router-<version>.tgz

# pi must be able to install and load it, in a throwaway agent directory
PI_CODING_AGENT_DIR=/tmp/pi-npm-check pi -e npm:@caph42/pi-jev-router --list-models jev
rm -rf /tmp/pi-npm-check
```

The last command should print:

```
provider  model  context  max-out  thinking  images
jev       auto   272K     128K     yes       yes
```

## Versioning

| Bump | When |
| --- | --- |
| patch | bug fixes, docs, internal refactors |
| minor | new config keys, new routing behavior that keeps existing `jev-router.json` files working |
| major | config keys renamed or removed, changed defaults, or anything that changes which model an existing config routes to |

Prereleases stay off the `latest` tag, so nobody installs them by accident:

```sh
npm version prerelease --preid=rc    # 0.1.0 → 0.1.1-rc.0
git push --follow-tags
npm publish --access public --tag next
```

A version can never be published twice. If a release is wrong, publish the next patch rather than
trying to overwrite it.

## Publishing is asynchronous

npm answers `202 Accepted` with *"Your package is being processed and may take a few minutes to
become available"*, and the read API can keep serving `404` for a minute or two after that. This is
normal; poll instead of re-publishing:

```sh
for i in $(seq 1 12); do
  npm view @caph42/pi-jev-router version && break
  sleep 15
done
```

`npm access list packages @caph42` shows the package as soon as the publish is accepted, which is a
useful way to tell "still processing" apart from "never arrived" — the latter exits with an error and
a non-zero status.

## Gotchas

- **Never have two installs of this extension loaded.** Developing from a checkout
  (`pi install ./path/to/pi-jev-router`) and also installing
  `npm:@caph42/pi-jev-router` registers `jev/auto` twice. Pick one: local path while editing, npm
  when you want to test the released artifact.
- `publishConfig.access = "public"` is required: scoped packages are private by default.
- The `pi` key in `package.json` points pi at `./extensions/jev-router.ts`; the `files` array decides
  what the tarball contains (5 files today). Anything outside it is not shipped.
- `pi-package` must stay in `keywords` for the pi.dev package gallery to pick the package up; the
  gallery is not instant.
- Users upgrade with `pi update --extensions`.
- `.npmrc`, `node_modules/`, and `*.tgz` are gitignored — keep it that way.

## 中文速览

发布前准备：在 npm 网页生成 **Granular Access Token**（Packages and scopes 选 `@caph42`、权限
Read and write、勾 **Bypass two-factor authentication**），写进 `~/.npmrc` 的
`//registry.npmjs.org/:_authToken=...`。换上新 token 后**不要**执行 `npm logout`（会把新 token
一起吊销）。

发版流程：`git status` 干净 → `npm pack --dry-run` 确认名字/版本/5 个文件 → `npm version
patch|minor|major` → `git push --follow-tags` → `npm publish --access public`。

npm 发布是异步的：返回 `202` 且“being processed”，读接口可能再 404 一两分钟，**不要急着重发**，
用轮询确认。验证三件事：`npm view` 版本正确、本地 `npm pack` 的 shasum 与线上一致、隔离 agent 目录下
`pi -e npm:@caph42/pi-jev-router --list-models jev` 能装能加载。

改动配置键（新增/改名/改默认值）时，同步更新 README 表格和 `jev-router.example.json`；破坏已有
`jev-router.json` 的改动要发 major。
