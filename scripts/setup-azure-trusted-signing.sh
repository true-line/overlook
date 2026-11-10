#!/usr/bin/env bash
# One-time setup for Windows code signing via Azure Trusted Signing
# (rebranded "Azure Artifact Signing" — both names appear in the portal and
# the CLI, and the RBAC role names use the NEW one).
#
# Run this yourself in a shell where you've already run `az login`. It walks
# the account/profile lookup, creates a service principal scoped to sign with
# that profile, and writes the three secrets to the repo via `gh secret set`.
#
# Prereqs:
#   - az CLI, plus the `trustedsigning` extension (installed below)
#   - gh CLI authenticated with admin on the repo (to set secrets)
#   - An Azure Trusted Signing account (portal: "Trusted Signing Accounts")
#   - Completed Identity Validation on that account — see step 2; this is a
#     real identity review by Microsoft and cannot be scripted.
#
# Every step below that looks gratuitous is here because it bit us during the
# real setup; the comments say which failure each one prevents.
set -euo pipefail

REPO="${REPO:-true-line/overlook}"
SP_NAME="${SP_NAME:-overlook-trusted-signing}"
SP_APP_ID="${SP_APP_ID:-}"

# Git Bash/MSYS2 rewrites any argument that looks like a Unix path (starts
# with "/") into a Windows path before it reaches az, silently mangling ARM
# scope strings like "/subscriptions/..." into "UserskksilCode...". That
# surfaces as a baffling "(MissingSubscription) The request did not have a
# subscription" on `az role assignment create`. Harmless on macOS/Linux.
export MSYS_NO_PATHCONV=1

az extension add --name trustedsigning --only-show-errors 2>/dev/null || true

# --- 0. Pick an active subscription ------------------------------------------
# Without an active subscription in context, `az trustedsigning list` fails
# with (MissingSubscription) even when your account owns exactly one.
echo "Subscriptions available to your account:"
az account list -o table
read -rp "Subscription ID (or name) to use: " SUBSCRIPTION
az account set --subscription "$SUBSCRIPTION"
TENANT_ID=$(az account show --query tenantId -o tsv)

# The RBAC plane must know this provider before any role can be scoped to one
# of its resources. Read calls via the trustedsigning extension succeed while
# registration is still pending, so this failure only shows up later — again
# as a misleading (MissingSubscription) on role assignment.
if [ "$(az provider show --namespace Microsoft.CodeSigning --query registrationState -o tsv)" != "Registered" ]; then
  echo "Registering Microsoft.CodeSigning resource provider (takes a minute)..."
  az provider register --namespace Microsoft.CodeSigning --wait
fi

# --- 1. Find your Trusted Signing account ------------------------------------
# NOTE: the account-level verbs are `az trustedsigning list|show` — there is NO
# `az trustedsigning account ...` subgroup ("'account' is misspelled or not
# recognized"). Only `certificate-profile` is a subgroup.
echo "Trusted Signing accounts in your subscription:"
az trustedsigning list -o table
read -rp "Resource group of the account to use: " RESOURCE_GROUP
read -rp "Trusted Signing account name: " ACCOUNT_NAME

ACCOUNT_ID=$(az trustedsigning show \
  --resource-group "$RESOURCE_GROUP" --name "$ACCOUNT_NAME" --query id -o tsv)

# The signing endpoint is exposed as `accountUri`, NOT `endpoint`. Querying
# `endpoint` silently returns an empty string rather than erroring, which is
# an easy way to end up with a blank value in electron-builder.yml.
ENDPOINT=$(az trustedsigning show \
  --resource-group "$RESOURCE_GROUP" --name "$ACCOUNT_NAME" \
  --query accountUri -o tsv)
echo "Endpoint (accountUri): $ENDPOINT"

# --- 2. Identity validation (portal only) ------------------------------------
# There is no `az trustedsigning identity-validation` command — the CLI has
# only `certificate-profile` as a subgroup. Identity validation happens in the
# portal and, for an individual, means a real ID/liveness check by Microsoft.
#
# Choose **Public Trust** + **Individual**:
#   - Public Trust chains to a publicly trusted root, which is what a public
#     download needs. Private Trust only validates inside a private PKI.
#   - Individual verifies you personally. The Organization path is what asks
#     for a DUNS number; individuals do not need one.
#
# The portal refuses with "Please ensure you have the 'Artifact Signing
# Identity Verifier' role assigned" until the role below is granted TO YOU
# (the human), which is separate from the signing role granted to the service
# principal further down.
echo ""
read -rp "Grant yourself the Identity Verifier role now (needed to do identity validation in the portal)? (y/N): " GRANT_VERIFIER
if [ "$GRANT_VERIFIER" = "y" ]; then
  USER_ID=$(az ad signed-in-user show --query id -o tsv)
  az role assignment create \
    --subscription "$SUBSCRIPTION" \
    --assignee "$USER_ID" \
    --role "Artifact Signing Identity Verifier" \
    --scope "$ACCOUNT_ID"
  echo "Granted. Allow a minute to propagate, then complete Identity validation in the portal."
fi

# --- 3. Certificate profile ---------------------------------------------------
echo ""
echo "Certificate profiles on that account:"
az trustedsigning certificate-profile list \
  --resource-group "$RESOURCE_GROUP" --account-name "$ACCOUNT_NAME" -o table

# An empty list here ([]) means no profile exists yet. Creating one requires
# the GUID of a COMPLETED identity validation, copied from the portal. Passing
# the ID of a validation that is not finished fails with:
#   (BadResourceOperation) ... identity validation details not found for Tenant
read -rp "Certificate profile name to use (or new name to create): " PROFILE_NAME
if ! az trustedsigning certificate-profile show \
  --resource-group "$RESOURCE_GROUP" --account-name "$ACCOUNT_NAME" \
  --name "$PROFILE_NAME" >/dev/null 2>&1; then
  echo "No profile named '$PROFILE_NAME' yet."
  read -rp "Identity validation GUID from the portal (blank to skip creation): " IDENTITY_VALIDATION_ID
  if [ -n "$IDENTITY_VALIDATION_ID" ]; then
    az trustedsigning certificate-profile create \
      --resource-group "$RESOURCE_GROUP" --account-name "$ACCOUNT_NAME" \
      --name "$PROFILE_NAME" --profile-type PublicTrust \
      --identity-validation-id "$IDENTITY_VALIDATION_ID"
  fi
fi

# publisherName must match the certificate's Common Name EXACTLY. For NSIS use
# the bare CN with no "CN=" prefix (only AppX/Store packages want the prefix).
PUBLISHER_NAME=$(az trustedsigning certificate-profile show \
  --resource-group "$RESOURCE_GROUP" --account-name "$ACCOUNT_NAME" \
  --name "$PROFILE_NAME" --query commonName -o tsv 2>/dev/null || echo "")
PROFILE_ID=$(az trustedsigning certificate-profile show \
  --resource-group "$RESOURCE_GROUP" --account-name "$ACCOUNT_NAME" \
  --name "$PROFILE_NAME" --query id -o tsv)

# --- 4. Service principal, scoped to just this certificate profile -----------
# Display names are not unique in Entra ID. Only reuse an application when the
# operator supplies its stable client ID; otherwise an attacker could pre-create
# $SP_NAME and receive the signing role from a name-only lookup.
RESET_PENDING=""
if [ -n "$SP_APP_ID" ]; then
  APP_ID=$(az ad sp show --id "$SP_APP_ID" --query appId -o tsv)
  if [ "$APP_ID" != "$SP_APP_ID" ]; then
    echo "SP_APP_ID must be the service principal's application (client) ID." >&2
    exit 1
  fi
  # The reset happens AFTER the role assignment succeeds and the operator
  # confirms the GitHub update: rotating first would strand the repository on
  # an invalidated AZURE_CLIENT_SECRET if anything later fails (PR #850
  # review).
  RESET_PENDING="yes"
  SP_PASSWORD=""
else
  echo "Creating service principal '$SP_NAME'..."
  # --role/--scope are omitted deliberately so no broad subscription-wide
  # Contributor grant is created; the narrow signing role is assigned below.
  SP_JSON=$(az ad sp create-for-rbac --name "$SP_NAME")
  APP_ID=$(printf '%s' "$SP_JSON" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).appId')
  SP_PASSWORD=$(printf '%s' "$SP_JSON" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).password')
fi

# The role is "ARTIFACT Signing Certificate Profile Signer". The older
# "Trusted Signing Certificate Profile Signer" name no longer resolves and
# fails with "Role ... doesn't exist."
az role assignment create \
  --subscription "$SUBSCRIPTION" \
  --assignee "$APP_ID" \
  --role "Artifact Signing Certificate Profile Signer" \
  --scope "$PROFILE_ID"

# RBAC assignments are additive: a principal migrated from the pre-#850 setup
# still holds the ACCOUNT-wide signer role, which would let a compromised CI
# principal sign with every profile in the account. Remove it once the
# profile-scoped grant above exists (PR #850 review).
LEGACY_ASSIGNMENT=$(az role assignment list \
  --subscription "$SUBSCRIPTION" \
  --assignee "$APP_ID" \
  --role "Artifact Signing Certificate Profile Signer" \
  --scope "$ACCOUNT_ID" \
  --query "[?scope=='$ACCOUNT_ID'] | [0].id" -o tsv 2>/dev/null || echo "")
if [ -n "$LEGACY_ASSIGNMENT" ]; then
  echo "Removing the legacy account-wide signer grant (superseded by the profile scope)..."
  az role assignment delete --ids "$LEGACY_ASSIGNMENT"
fi

# The deferred rerun rotation (see section 4): everything that can fail has
# succeeded, so invalidating the old password can no longer strand CI.
if [ "$RESET_PENDING" = "yes" ]; then
  echo "Resetting credentials for explicitly selected service principal $APP_ID..."
  SP_PASSWORD=$(az ad sp credential reset --id "$APP_ID" --query password -o tsv)
fi

# --- 5. Non-secret config: paste into electron-builder.yml --------------------
echo ""
echo "win.azureSignOptions values for electron-builder.yml:"
echo "  publisherName:           ${PUBLISHER_NAME:-<CN of the signing certificate>}"
echo "  endpoint:                $ENDPOINT"
echo "  codeSigningAccountName:  $ACCOUNT_NAME"
echo "  certificateProfileName:  $PROFILE_NAME"
echo ""

# --- 6. Secrets: written straight to the repo, never echoed -------------------
if [ -z "$SP_PASSWORD" ]; then
  echo "No new password generated, so AZURE_CLIENT_SECRET is unchanged."
  echo "Tenant: $TENANT_ID   Client ID: $APP_ID"
  exit 0
fi

read -rp "Set AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET on $REPO now? (y/N): " CONFIRM
if [ "$CONFIRM" = "y" ]; then
  gh secret set AZURE_TENANT_ID --repo "$REPO" --body "$TENANT_ID"
  gh secret set AZURE_CLIENT_ID --repo "$REPO" --body "$APP_ID"
  gh secret set AZURE_CLIENT_SECRET --repo "$REPO" --body "$SP_PASSWORD"
  echo "Secrets set on $REPO."
else
  echo "Skipped. Client ID: $APP_ID"
  echo "Azure will not show the password again — reset it with:"
  echo "  az ad sp credential reset --id $APP_ID"
fi
