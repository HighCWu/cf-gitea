/**
 * Version string reported by `GET /version` (SPEC-0004 open question 1,
 * resolved: report the pinned upstream Gitea version — SDKs gate client
 * behavior on it).
 *
 * Value tracks the submodule pin, composed the way upstream's Makefile
 * composes GITEA_VERSION from `git describe --tags --always`:
 * `sed 's/-/+/' | sed 's/^v//'` (gitea/Makefile, "GITEA_VERSION" target).
 * Pinned describe output: `v29.0.0-dev-208-gfc49368845`. Re-pin = update this
 * one line (run `git -C gitea describe --tags --always` and apply the same
 * composition).
 */
export const SERVER_VERSION = "29.0.0+dev-208-gfc49368845";

/**
 * Path under the instance origin where the API documentation lives. Upstream
 * points every error body's `url` field here (`setting.API.SwaggerURL` =
 * AppURL + "api/swagger", gitea/modules/setting/api.go).
 */
export const SWAGGER_DOC_PATH = "/api/swagger";
