/**
 * The team invite redemption page (census B-77) — upstream
 * `templates/org/team/invite.tmpl` over `org.TeamInvite` +
 * `org.TeamInvitePost` (routers/web/org/teams.go:583-627, web.go:976-978's
 * `/org/invite/{token}` GET+POST pair inside the reqSignIn group). The
 * upstream template is a bare centered card: the org avatar, the
 * `org.teams.invite.title` sentence, the inviter line, the description, and
 * ONE form POSTing the same URL — there is NO decline arm upstream (an
 * invitee "declines" by ignoring the mail; removal is the ORG-side
 * `remove_invite` action, teams.go:204-222). Any signed-in bearer of the
 * token may join — TeamInvitePost never compares the doer's email with
 * `invite.Email` (the token IS the authority; the mail's intended-for note
 * is the only soft guard).
 */

import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { orgDisplayName } from "./org-home";
import type { OrgRecord } from "../../services/orgs/orgs";
import type { TeamInviteRecord } from "../../api/routes/org-teams";

/** Page chrome text (component-local, the orgTeamsLocale pattern — locale.ts
 *  is shared and not this wave's file). */
export const teamInviteLocale = {
  /** "org.teams.invite.title" — the <strong> tags are the LOCALE STRING's
   *  own HTML (upstream Tr renders it raw); the names interpolate escaped. */
  title_prefix: "You have been invited to join team ",
  title_between: " in organization ",
  by: "Invited by", // "org.teams.invite.by" ("Invited by %s")
  description: "Please click the button below to join the team.", // "org.teams.invite.description"
  join: "Join", // "org.teams.join"
} as const;

/** The redeem page's render inputs — the four rows getTeamInviteFromContext
 *  resolves (teams.go:629-653: invite by token, inviter by InviterID, team
 *  by TeamID, org by team.OrgID). */
export interface OrgTeamInviteData {
  /** The browser title (upstream ctx.Data["Title"] = Tr(
   *  "org.teams.invite_team_member", team.Name) — "Invite to %s"). */
  title: string;
  invite: Pick<TeamInviteRecord, "token" | "email">;
  org: OrgRecord;
  /** The team slice the sentences need (the record rides the loaders). */
  team: { name: string; lowerName: string };
  inviter: { username: string };
}

/**
 * The redemption card (invite.tmpl verbatim: the centered flex-relaxed-list,
 * the 140 org avatar — the icon-allowlist reduction of ctx.AvatarUtils.
 * Avatar, the three locale lines, the self-POSTing join form).
 */
export function OrgTeamInvitePage(props: { ctx: UiContext; data: OrgTeamInviteData }) {
  const { ctx, data } = props;
  return (
    <BaseLayout ctx={ctx} title={data.title} pageClass="organization teams">
      <div role="main" aria-label={data.title} class="page-content">
        <div class="ui container">
          <div class="tw-flex tw-justify-center">
            <div class="flex-relaxed-list">
              {/* invite.tmpl:7 — Avatar .Organization 140 (the icon reduction). */}
              <div class="tw-flex tw-justify-center">
                <span class="ui avatar" aria-hidden="true">
                  <Icon name="octicon-organization" size={140} />
                </span>
              </div>
              {/* invite.tmpl:8 — Tr "org.teams.invite.title" Team.Name
                  Organization.Name. */}
              <div>
                {teamInviteLocale.title_prefix}
                <strong>{data.team.name}</strong>
                {teamInviteLocale.title_between}
                <strong>{orgDisplayName(data.org)}</strong>.
              </div>
              {/* invite.tmpl:9 — Tr "org.teams.invite.by" Inviter.Name. */}
              <div>
                {teamInviteLocale.by} {data.inviter.username}
              </div>
              {/* invite.tmpl:10 — "org.teams.invite.description". */}
              <div>{teamInviteLocale.description}</div>
              {/* invite.tmpl:11-13 — the join form POSTs the SAME path
                  (action="" — the browser resolves it to /org/invite/{token});
                  TeamInvitePost joins + removes the invite (teams.go:608-627). */}
              <form class="ui form tw-mt-4" action="" method="post">
                <button type="submit" class="fluid ui primary button">
                  {teamInviteLocale.join}
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The full-document render (the renderOrgTeamDetailPage pattern). */
export function renderOrgTeamInvitePage(ctx: UiContext, data: OrgTeamInviteData): string {
  return renderPage(<OrgTeamInvitePage ctx={ctx} data={data} />);
}
