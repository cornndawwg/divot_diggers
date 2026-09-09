-- 0018  Invite somebody to a group, with the role they will hold when they accept.
--
-- Before this the only way into a group was to create one, so a group of one was the only
-- kind of group there could be. Levi cannot be made the Divot Diggers' owner because there
-- is no way to get Levi an account attached to the Divot Diggers at all.
--
-- An invitation names an email and a role. Accepting it makes the membership. The token is
-- the secret in the emailed link, so it is stored hashed — a leaked database backup should
-- not hand somebody a working set of invitations, and nothing ever needs the original again.

CREATE TABLE org_invitations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email         text NOT NULL,
  role          text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  -- sha256 of the token in the link. The token itself is never stored.
  token_hash    text NOT NULL UNIQUE,
  invited_by    uuid REFERENCES people(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  accepted_at   timestamptz,
  accepted_by   uuid REFERENCES people(id) ON DELETE SET NULL,
  revoked_at    timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  row_version   bigint NOT NULL DEFAULT nextval('row_version_seq'),
  -- An invitation is either open, accepted or revoked; never accepted and revoked both.
  CONSTRAINT invitation_not_both_ways CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);

-- One open invitation per email per group. Re-inviting replaces rather than accumulates,
-- so a person cannot end up holding three links granting three different roles.
CREATE UNIQUE INDEX org_invitation_one_open
  ON org_invitations (org_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX org_invitation_by_org ON org_invitations (org_id);

ALTER TABLE org_invitations ENABLE ROW LEVEL SECURITY;

-- Only the group's owners and admins can see or manage its invitations. The person being
-- invited does not read the row — they present the token, and accept_org_invitation does the
-- looking up, because at that moment they are not yet a member of anything.
CREATE POLICY org_invitation_read ON org_invitations
  FOR SELECT USING (is_org_admin(org_id));
CREATE POLICY org_invitation_write ON org_invitations
  FOR ALL USING (is_org_admin(org_id)) WITH CHECK (is_org_admin(org_id));

-- Issue an invitation. Returns its id; the caller keeps the token and puts it in the email.
--
-- Only an owner may invite an owner, matching set_org_role: an admin who could invite an
-- owner could invite themselves back as one.
CREATE OR REPLACE FUNCTION invite_to_org(
  target_org uuid, invite_email text, invite_role text, hashed_token text, valid_days integer
) RETURNS uuid AS $$
DECLARE
  caller uuid := current_person_id();
  caller_role text;
  new_id uuid;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;
  IF invite_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'A group role is owner, admin or member, not %', invite_role;
  END IF;

  SELECT role INTO caller_role FROM org_members
   WHERE org_id = target_org AND person_id = caller AND removed_at IS NULL;
  IF caller_role IS NULL OR caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only a group owner or group admin can invite people';
  END IF;
  IF caller_role <> 'owner' AND invite_role = 'owner' THEN
    RAISE EXCEPTION 'Only a group owner can invite another owner';
  END IF;

  -- Replace any invitation still outstanding for this address rather than stacking another.
  UPDATE org_invitations SET revoked_at = now(), updated_at = now()
   WHERE org_id = target_org AND lower(email) = lower(invite_email)
     AND accepted_at IS NULL AND revoked_at IS NULL;

  INSERT INTO org_invitations (org_id, email, role, token_hash, invited_by, expires_at)
  VALUES (target_org, invite_email, invite_role, hashed_token, caller,
          now() + make_interval(days => valid_days))
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Accept one. The caller is whoever is signed in; the token is what proves they were asked.
--
-- The email on the invitation is not checked against the accepter's, deliberately: people are
-- invited at the address someone had for them and sign up with whichever address they
-- actually use. Holding the emailed token is the proof. Who accepted it is recorded.
CREATE OR REPLACE FUNCTION accept_org_invitation(hashed_token text)
RETURNS uuid AS $$
DECLARE
  caller uuid := current_person_id();
  invitation org_invitations%ROWTYPE;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;

  SELECT * INTO invitation FROM org_invitations WHERE token_hash = hashed_token;
  IF invitation.id IS NULL THEN
    RAISE EXCEPTION 'That invitation link is not valid.';
  END IF;
  IF invitation.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'That invitation was withdrawn.';
  END IF;
  IF invitation.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'That invitation has already been used.';
  END IF;
  IF invitation.expires_at < now() THEN
    RAISE EXCEPTION 'That invitation has expired. Ask for a new one.';
  END IF;

  INSERT INTO org_members (org_id, person_id, role)
  VALUES (invitation.org_id, caller, invitation.role)
  ON CONFLICT (org_id, person_id)
    DO UPDATE SET role = excluded.role, removed_at = NULL, updated_at = now();

  UPDATE org_invitations
     SET accepted_at = now(), accepted_by = caller, updated_at = now()
   WHERE id = invitation.id;

  RETURN invitation.org_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
