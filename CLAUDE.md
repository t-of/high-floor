# HIGH FLOOR

T.OF... のアプリ。https://t-of.github.io/high-floor/

- ルールは本部の `~/GitHub/tof/t-of.github.io/RULES.md` に従う（全アプリ共通）。ブランドは `docs/BRAND.md`。
- 直したら本部で `npm run audit:browser -- high-floor` を通す。
- 公開は本部の `docs/RELEASE.md` の手順。大きな作業は本部で Claude を起動すると、役割を分けて進められる。
- localStorage のキーは `high-floor.` で始める。SW のキャッシュ名は `high-floor-` で始める。
- 計算は `logic.js`（画面に依存しない）。直したら `npm test` を通す。仕様は本部の `docs/private/specs/high-floor.md`。
- 名前・希望点は通信しない。外部のスクリプト（フォント・計測・広告）を入れるときは、画面の「名前と希望はこの端末から出ません」を見直す。
