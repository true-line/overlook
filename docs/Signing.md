# Windows code signing

Windows installers are signed with [Azure Trusted
Signing](https://learn.microsoft.com/en-us/azure/trusted-signing/overview)
(individual identity validation), configured in `electron-builder.yml` under
`win.azureSignOptions` (#683). There is no local `.pfx`/`.p12` — signing
happens against the Trusted Signing Account in Azure at build time.

## Required repository secrets

The Package workflow (`.github/workflows/package.yml`) authenticates to
Microsoft Entra ID as a service principal via
[`EnvironmentCredential`](https://learn.microsoft.com/en-us/dotnet/api/azure.identity.environmentcredential):

| Secret                | Value                                          |
| --------------------- | ---------------------------------------------- |
| `AZURE_TENANT_ID`     | Microsoft Entra tenant ID                      |
| `AZURE_CLIENT_ID`     | App registration (service principal) client ID |
| `AZURE_CLIENT_SECRET` | Client secret for that app registration        |

The service principal needs the **Artifact Signing Certificate Profile Signer**
role (Trusted Signing was rebranded to Artifact Signing; this is the current
role name) on the Certificate Profile referenced by
`win.azureSignOptions.certificateProfileName`.

When these secrets are absent, the Windows legs still build — the workflow
passes `-c.win.azureSignOptions=null` to force an unsigned build rather than
failing (mirrors the mac `-c.mac.identity=null` unsigned path).

## Secret scope

Signing secrets (the Azure `AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`
service principal, and the mac `CSC_LINK`/`CSC_KEY_PASSWORD`/`APPLE_API_*` set)
are exposed only to the workflow's **Package** step, which packages an
already-built app via the build-free `dist*` npm scripts. The build
(`npm run build`, electron-vite plus every build-time dependency) runs in a
separate step with no signing material in its environment, so a compromised
build dependency cannot read the certificate or the service-principal
credentials (#855). The invariant is pinned by
`tests/tooling/signing-secret-scope.test.ts`.

## Configuration values

`electron-builder.yml`'s `win.azureSignOptions` block holds the non-secret
account coordinates (publisher name, endpoint, account name, certificate
profile name) — these aren't credentials, so they're committed directly
rather than passed as secrets:

- `publisherName` — must exactly match the CN on the Trusted Signing
  certificate.
- `endpoint` — the Trusted Signing Account's region-specific endpoint (e.g.
  `https://eus.codesigning.azure.net/`).
- `codeSigningAccountName` — the Trusted Signing Account name.
- `certificateProfileName` — the Certificate Profile name under that account.

## First-time setup

`scripts/setup-azure-trusted-signing.sh` automates the setup sequence. It is
interactive and idempotent — run it from a shell where `az login` and
`gh auth login` have already succeeded. This section documents what it does
and, more usefully, the non-obvious parts that are easy to get stuck on.

On the first run, the script creates a dedicated service principal. On a rerun,
pass its application (client) ID explicitly as `SP_APP_ID=<client-id>`; Entra
display names are not unique and are never used to select an existing identity.
The rerun rotates that principal's password only after the role assignment
succeeds (a failure part-way never strands CI on an invalidated secret) and
then updates the repository secret. The signer role is scoped to the selected
Certificate Profile, not its parent Trusted Signing Account; a legacy
account-wide grant left by earlier runs is removed once the profile-scoped
grant exists.

**The CLI surface.** Account-level verbs are `az trustedsigning list|show` —
there is no `az trustedsigning account ...` subgroup, and asking for one
reports `'account' is misspelled or not recognized`. `certificate-profile` is
the only subgroup.

**`MissingSubscription` has two unrelated causes.** Both surface as the same
error on `az role assignment create`:

1. No active subscription in context — fix with `az account set --subscription`.
2. The `Microsoft.CodeSigning` resource provider is unregistered. Read calls
   through the extension succeed while registration is pending, so this only
   fails later, at role assignment. Fix with
   `az provider register --namespace Microsoft.CodeSigning --wait`.

**Git Bash mangles ARM scope strings.** MSYS2 rewrites arguments starting with
`/` into Windows paths, turning `--scope /subscriptions/...` into
`UserskksilCode...` before `az` ever sees it — which also reports as
`MissingSubscription`. Export `MSYS_NO_PATHCONV=1`. Not an issue on
macOS/Linux.

**Identity validation is portal-only** and cannot be scripted: for an
individual it is a real ID/liveness check performed by Microsoft. Choose
**Public Trust** (chains to a publicly trusted root, required for public
downloads; Private Trust only validates inside a private PKI you control) and
**Individual** (the Organization path is the one that requires a DUNS number).
The portal blocks this until your own user account holds the **Artifact
Signing Identity Verifier** role — separate from the signing role the service
principal needs.

**Certificate profile creation** needs the GUID of a _completed_ identity
validation. Supplying one that has not finished fails with
`(BadResourceOperation) ... identity validation details not found for Tenant`.

**Both role names begin with "Artifact Signing"**, not "Trusted Signing" — the
service was rebranded and the older names no longer resolve
(`Role ... doesn't exist`).

**Reading the config values back out.** The signing endpoint is exposed as
`accountUri`, _not_ `endpoint`; querying `endpoint` returns an empty string
instead of erroring, which quietly yields a blank value in
`electron-builder.yml`. `publisherName` comes from the profile's `commonName`
and, for NSIS, is the bare CN with no `CN=` prefix (only AppX/Store packages
want the prefix):

```sh
az trustedsigning show -g <rg> -n <account> --query accountUri -o tsv
az trustedsigning certificate-profile show -g <rg> --account-name <account> \
  --name <profile> --query commonName -o tsv
```

## Verifying a signed binary

From an elevated PowerShell prompt on Windows, against a downloaded installer:

```powershell
signtool verify /pa /v .\Overlook-<version>-<arch>.exe
```

or:

```powershell
Get-AuthenticodeSignature .\Overlook-<version>-<arch>.exe
```

Expect `Status: Valid`, a signer subject matching `publisherName`, and an RFC
3161 countersignature timestamp. `NotSigned` or `HashMismatch` means signing
failed or was skipped — check the Package workflow run for which branch it
took, gated on all three `AZURE_TENANT_ID`/`AZURE_CLIENT_ID`/
`AZURE_CLIENT_SECRET` secrets being present.

The same Package workflow builds the Windows live-local Node-API binding for
each target architecture. Its x64 leg exercises the real named-pipe DACL,
second-owner rejection, bounded framing, and native-host registry cleanup; both
legs then prove every packaged native binary matches the installer target.
