/**
 * The user settings profile page, `/user/settings` — pages wave 12
 * (SPEC-0008 U3 extension): the signed-in viewer's account profile form.
 * Signed-in only (upstream's reqSignIn /user group — anonymous 303s onto the
 * login round-trip; there is no non-admin shell here: every signed-in viewer
 * manages exactly their own row, the viewer IS the target).
 *
 * ## Data (§3.2 — the landed user-settings surface, never a self-fetch)
 *
 * The landed user-settings family is `GET/PATCH /user/settings`
 * (routes/user-settings.ts over services/user-settings.ts): the NINE
 * contract fields split across the `users` profile columns (`full_name` →
 * `display_name`, `description`, `website`, `location`) and the
 * `user_settings` side store (`theme`, `language`, `diff_view_style`,
 * `hide_email`, `hide_activity`). The PATCH owns exactly those nine — the
 * request shape surveys as: NO `email` key, NO `name` (username) key, NO
 * `visibility` key. The page therefore renders, exactly per upstream
 * profile.tmpl's own arms:
 *
 *   editable    full_name, description, website, location (the profile
 *               columns) + the two Privacy checkboxes the arm owns —
 *               `keep_email_private` → hide_email, `keep_activity_private`
 *               → hide_activity (the SAME switches the PATCH body writes,
 *               services/user-settings.ts's round-trip note);
 *   read-only   username (a disabled input — upstream's own disabled shape),
 *               email (upstream renders it as the read-only
 *               `<p id="signed-user-email">` too — the arm has no email key),
 *               visibility (text — upstream's dropdown, no landed write arm).
 *
 * The PATCH's preference half beyond the profile page (theme / language /
 * diff_view_style) is upstream appearance.tmpl's field set, not
 * profile.tmpl's — not rendered here (the brief pins profile.tmpl).
 *
 * NO password or token management UI: upstream's Account (password change),
 * Security (2FA), Applications (tokens/OAuth2) and SSH/GPG Keys navbar
 * items have no landed surfaces — the settings navbar (user/settings/
 * layout_head.tmpl + navbar.tmpl) reduces to the header + the single live
 * Profile item (the dead-link rule), and nothing on this page touches
 * credentials (no password field is rendered at all).
 *
 * ## DOM contract (templates/user/settings/{layout_head,navbar,profile}.tmpl
 *  at the pin)
 *
 * `.page-content.user settings profile` (layout_head's pageClass), then
 * `.ui.container.flex-container` with the
 * `.flex-container-nav > .ui.fluid.vertical.menu` settings navbar and the
 * `.flex-container-main` content: profile.tmpl's Public Profile header +
 * attached segment (`<p>{settings.profile_desc}</p>` then the form), the
 * divider, the Privacy label block, the two checkbox fields, the submit.
 * Field names are exactly the upstream form's (`name` [disabled, never
 * submitted], `full_name`, `description`, `website`, `location`,
 * `keep_email_private`, `keep_activity_private`) with upstream's
 * maxlengths (40/100/255/255/50).
 *
 * ## Write path (§3.2)
 *
 * The POST re-plays the PATCH route's exact service sequence for the form's
 * fields — `saveUserProfileColumns` (the four users columns; an empty string
 * clears, upstream UpdateOptions' empty-pointer semantics) then
 * `saveUserSettings` (the two hide flags; the preference keys the form does
 * not carry are `undefined` = keep the stored value, the Go pointer
 * semantics) — success 303s back onto the canonical `/user/settings`
 * (upstream SettingsPost redirects onto the profile page, upstream's
 * Flash.Error/Success reduction: no session-flash plumbing exists, so no
 * flash line renders). No validation arms exist server-side: the Go
 * MaxSize/ValidUrl binding limits are accepted-and-ignored by the landed
 * services (services/user-settings.ts's divergence note) — the HTML5
 * input types/maxlengths carry the client side.
 *
 * Not rendered (documented degradations): profile.tmpl's avatar section
 * (the second form — no avatar pipeline, the standing avatar-slot rule), the
 * `name-change-prompt` warning spans (username is never editable here), and
 * the visibility dropdown's tooltip matrix (read-only text line).
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  loadUserSettings,
  saveUserSettings,
  saveUserProfileColumns,
  type UserPreferenceSettings,
} from "../../api/services/user-settings";
import { users } from "../../db/schema";
import { BaseLayout, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

/** Page chrome text (component-local, the settingsLocale pattern — locale.ts
 *  is shared and not this wave's file). */
export const userSettingsLocale = {
  settings: "User Settings", // "user.settings" (the navbar header)
  profile: "Profile", // "settings.profile"
  public_profile: "Public Profile", // "settings.public_profile"
  profile_desc:
    "Control how your profile is shown to other users. Your primary email address will be used for notifications, password recovery and web-based Git operations.", // "settings.profile_desc"
  username: "Username", // "username"
  username_disabled: "This username is managed by the deployment and cannot be changed here.", // cf-gitea addition (upstream's password_username_disabled speaks of auth sources we do not model)
  full_name: "Full Name", // "settings.full_name"
  email: "Email Address", // "email"
  biography: "Biography", // "user.user_bio"
  biography_placeholder: "Tell us a little bit about yourself! (You can use Markdown)", // "settings.biography_placeholder"
  website: "Website", // "settings.website"
  location: "Location", // "settings.location"
  location_placeholder: "Share your approximate location with others", // "settings.location_placeholder"
  privacy: "Privacy", // "settings.privacy"
  visibility: "User visibility", // "settings.visibility"
  visibility_public: "Public", // "settings.visibility.public"
  visibility_limited: "Limited", // "settings.visibility.limited"
  visibility_private: "Private", // "settings.visibility.private"
  keep_email_private: "Hide Email Address", // "settings.keep_email_private"
  keep_activity_private: "Hide Activity from profile page", // "settings.keep_activity_private"
  update_profile: "Update Profile", // "settings.update_profile"
} as const;

/** The page's full `users` row (username/email/visibility render beside the
 *  editable profile columns). */
export type UserSettingsRow = typeof users.$inferSelect;

/** The page render inputs: the users row plus the stored preferences (the
 *  five-field side store — only the two hide flags render). */
export interface UserSettingsPageData {
  user: UserSettingsRow;
  settings: UserPreferenceSettings;
}

/**
 * Load the page (the GET arm's two stores): the users row (the route's
 * findSettingsRow slice widened with username/email/visibility) and
 * `loadUserSettings`. `null` = the session doer has no D1 row (the
 * silent-auth-failure convention — the 404 shell, the file-editor pattern).
 */
export async function loadUserSettingsPageData(d1: D1Database, userId: number): Promise<UserSettingsPageData | null> {
  const row = await drizzle(d1).select().from(users).where(eq(users.id, userId)).get();
  if (row === undefined) return null;
  return { user: row, settings: await loadUserSettings(d1, userId) };
}

/** The form's fields (upstream profile.tmpl's field names). */
export interface UserProfileForm {
  fullName: string;
  description: string;
  website: string;
  location: string;
  hideEmail: boolean;
  hideActivity: boolean;
}

/** Parse the urlencoded profile POST — a checkbox's absence is the unchecked
 *  state (the parseFormBool convention). */
export function parseUserProfileForm(params: URLSearchParams): UserProfileForm {
  return {
    fullName: params.get("full_name") ?? "",
    description: params.get("description") ?? "",
    website: params.get("website") ?? "",
    location: params.get("location") ?? "",
    hideEmail: (params.get("keep_email_private") ?? "") !== "",
    hideActivity: (params.get("keep_activity_private") ?? "") !== "",
  };
}

/**
 * The write — the PATCH route's exact sequence (routes/user-settings.ts
 * updateUserSettingsRoute) for the form's fields: the four profile columns
 * (always presented by a form POST; an empty string clears, upstream's
 * empty-pointer semantics) then the two hide flags (the un-carried
 * preference keys stay `undefined` = keep the stored value). Always
 * succeeds — the service layer carries no validation arms (the module
 * header's binding-limits note).
 */
export async function applyUserProfileForm(d1: D1Database, userId: number, form: UserProfileForm): Promise<void> {
  await saveUserProfileColumns(d1, userId, {
    displayName: form.fullName,
    description: form.description,
    website: form.website,
    location: form.location,
  });
  await saveUserSettings(d1, userId, {
    hideEmail: form.hideEmail,
    hideActivity: form.hideActivity,
  });
}

/** The settings navbar (user/settings/navbar.tmpl reduced to the single live
 *  item — the dead-link rule; upstream's Account/Security/Applications/Keys/
 *  Appearance/Audit/Actions items have no landed pages). */
function UserSettingsNav() {
  return (
    <div class="flex-container-nav">
      <div class="ui fluid vertical menu">
        <div class="header item">{userSettingsLocale.settings}</div>
        <a class="active item" href="/user/settings">
          {userSettingsLocale.profile}
        </a>
      </div>
    </div>
  );
}

/** The visibility text under the read-only line (upstream's dropdown is the
 *  no-write-arm reduction). */
function visibilityText(visibility: string): string {
  if (visibility === "limited") return userSettingsLocale.visibility_limited;
  if (visibility === "private") return userSettingsLocale.visibility_private;
  return userSettingsLocale.visibility_public;
}

/** The full-document render (the render.tsx pattern). */
export function renderUserSettingsPage(ctx: UiContext, data: UserSettingsPageData): string {
  return renderPage(<UserSettingsPage ctx={ctx} data={data} />);
}

/** The profile page (§2.4.1 discriminator: `user settings profile` —
 *  layout_head's pageClass). */
export function UserSettingsPage(props: { ctx: UiContext; data: UserSettingsPageData }) {
  const { ctx, data } = props;
  const user = data.user;
  return (
    <BaseLayout ctx={ctx} title={userSettingsLocale.settings} pageClass="user settings profile">
      <div class="ui container flex-container">
        <UserSettingsNav />
        <div class="flex-container-main">
          <h4 class="ui top attached header">{userSettingsLocale.public_profile}</h4>
          <div class="ui attached segment">
            <p>{userSettingsLocale.profile_desc}</p>
            <form class="ui form" action="/user/settings" method="post">
              {/* profile.tmpl's required field — the disabled shape (the arm
                  owns no name key; disabled inputs are never submitted). */}
              <div class="required field">
                <label for="username">{userSettingsLocale.username}</label>
                <input id="username" name="name" value={user.username} data-name={user.username} required disabled maxlength={40} />
                <p class="help">{userSettingsLocale.username_disabled}</p>
              </div>
              <div class="field">
                <label for="full_name">{userSettingsLocale.full_name}</label>
                {/* The column the landed GET/PATCH pair reads/writes —
                    services/user-settings.ts maps `full_name` onto
                    users.display_name (the User.full_name projection's
                    home), NOT the org-column full_name. */}
                <input id="full_name" name="full_name" value={user.displayName ?? ""} maxlength={100} />
              </div>
              {/* Upstream's read-only arm verbatim: the email renders as a
                  <p>, never an input (the settings arm owns no email key). */}
              <div class="field">
                <label>{userSettingsLocale.email}</label>
                <p id="signed-user-email">{user.email ?? ""}</p>
              </div>
              <div class="field">
                <label for="description">{userSettingsLocale.biography}</label>
                <textarea id="description" name="description" rows={2} placeholder={userSettingsLocale.biography_placeholder} maxlength={255}>
                  {user.description ?? ""}
                </textarea>
              </div>
              <div class="field">
                <label for="website">{userSettingsLocale.website}</label>
                <input id="website" name="website" type="url" value={user.website ?? ""} maxlength={255} />
              </div>
              <div class="field">
                <label for="location">{userSettingsLocale.location}</label>
                <input id="location" name="location" placeholder={userSettingsLocale.location_placeholder} value={user.location ?? ""} maxlength={50} />
              </div>
              <div class="divider" />
              {/* The private block — visibility is read-only text (no landed
                  write arm), the two checkboxes are the PATCH arm's flags. */}
              <div class="field" id="privacy-user-settings">
                <label>
                  <strong>{userSettingsLocale.privacy}</strong>
                </label>
              </div>
              <div class="inline field">
                <span class="inline required field">
                  <label>{userSettingsLocale.visibility}</label>
                </span>
                <span>{visibilityText(user.visibility)}</span>
              </div>
              <div class="field">
                <div class="ui checkbox">
                  <input id="keep_email_private" name="keep_email_private" type="checkbox" checked={data.settings.hideEmail} />
                  <label for="keep_email_private">
                    <strong>{userSettingsLocale.keep_email_private}</strong>
                  </label>
                </div>
              </div>
              <div class="field">
                <div class="ui checkbox" id="keep-activity-private">
                  <input id="keep_activity_private" name="keep_activity_private" type="checkbox" checked={data.settings.hideActivity} />
                  <label for="keep_activity_private">
                    <strong>{userSettingsLocale.keep_activity_private}</strong>
                  </label>
                </div>
              </div>
              <div class="divider" />
              <div class="field">
                <button type="submit" class="ui primary button">
                  {userSettingsLocale.update_profile}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
