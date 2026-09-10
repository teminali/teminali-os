import React from "react";
import { KeyRound } from "lucide-react";
import { Button, Modal } from "../ui";
import type { BrowserWebauthnRequest } from "../../services/browserView";

/**
 * Which passkey, when a site has more than one of yours.
 *
 * Not an ordinary modal: main is holding the page's `navigator.credentials.get()`
 * promise open until this answers. Electron cancels the request outright if no
 * listener replies, so every way out of here has to produce an answer —
 * choosing one, dismissing (which is a cancel, and reaches the page as the same
 * `NotAllowedError` a browser's own dismissed sheet produces), or the timeout
 * main keeps behind this. See electron/browserView.cjs.
 *
 * Built on `Modal` for the reason `BrowserImportModal` documents: the browser
 * panel's page is a native view above this document, and only a
 * `[role="dialog"]` makes it get out of the way.
 *
 * The names are the site's text, not ours. They are rendered as text and
 * nothing here follows them anywhere.
 */
export const BrowserPasskeyModal: React.FC<{
  request: BrowserWebauthnRequest | null;
  onChoose: (credentialId: string | null) => void;
}> = ({ request, onChoose }) => (
  <Modal
    isOpen={Boolean(request)}
    onClose={() => onChoose(null)}
    title="Choose a passkey"
    subtitle={request ? `${request.relyingPartyId} has more than one of your passkeys` : undefined}
    icon={<KeyRound size={14} />}
    size="sm"
    footer={
      <Button variant="ghost" size="sm" onClick={() => onChoose(null)}>
        Cancel
      </Button>
    }
  >
    <div className="flex flex-col gap-1.5">
      {(request?.accounts ?? []).map((account) => {
        const primary = account.name || account.displayName || "Passkey";
        const secondary = account.displayName && account.displayName !== primary ? account.displayName : null;
        return (
          <button
            key={account.credentialId}
            type="button"
            onClick={() => onChoose(account.credentialId)}
            className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg border border-edge-chrome text-left hover:bg-accent/10 hover:border-accent/40 transition-colors duration-ds ease-ds"
          >
            <KeyRound size={13} className="text-ink-faint flex-shrink-0" />
            <span className="min-w-0">
              <span className="block text-xs text-ink truncate">{primary}</span>
              {secondary && <span className="block text-2xs text-ink-dim truncate">{secondary}</span>}
            </span>
          </button>
        );
      })}
    </div>
  </Modal>
);
