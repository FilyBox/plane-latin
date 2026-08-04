/**
 * Community-compatible envelope settings modelled after Documenso's CE editor.
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useState } from "react";
import { Bell, Mail, Settings, ShieldCheck, X } from "lucide-react";
import { useTranslation } from "@plane/i18n";
import type { TContractAuthoringSettings } from "@plane/types";
import { Button } from "@plane/propel/button";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { ContractField, ContractInput, ContractSelect } from "./ui";

type SettingsTab = "GENERAL" | "REMINDERS" | "NOTIFICATIONS" | "SECURITY";

type Props = {
  value: TContractAuthoringSettings;
  onChange: (value: TContractAuthoringSettings) => void;
  onClose: () => void;
};

const tabs: Array<{ id: SettingsTab; labelKey: string; icon: typeof Settings }> = [
  { id: "GENERAL", labelKey: "file_library.contracts.workflow.settings.general", icon: Settings },
  { id: "REMINDERS", labelKey: "file_library.contracts.workflow.settings.reminders", icon: Bell },
  { id: "NOTIFICATIONS", labelKey: "file_library.contracts.workflow.settings.notifications", icon: Mail },
  { id: "SECURITY", labelKey: "file_library.contracts.workflow.settings.security", icon: ShieldCheck },
];

const emailOptions: Array<{ key: keyof TContractAuthoringSettings["emailSettings"]; labelKey: string }> = [
  { key: "recipientSigningRequest", labelKey: "file_library.contracts.workflow.settings.recipient_signing_request" },
  { key: "recipientRemoved", labelKey: "file_library.contracts.workflow.settings.recipient_removed" },
  { key: "recipientSigned", labelKey: "file_library.contracts.workflow.settings.recipient_signed" },
  { key: "documentPending", labelKey: "file_library.contracts.workflow.settings.document_pending" },
  { key: "documentCompleted", labelKey: "file_library.contracts.workflow.settings.document_completed" },
  { key: "documentDeleted", labelKey: "file_library.contracts.workflow.settings.document_deleted" },
  { key: "ownerDocumentCompleted", labelKey: "file_library.contracts.workflow.settings.owner_completed" },
  { key: "ownerRecipientExpired", labelKey: "file_library.contracts.workflow.settings.recipient_expired" },
  { key: "ownerDocumentCreated", labelKey: "file_library.contracts.workflow.settings.owner_created" },
];

export function ContractEnvelopeSettingsDialog({ value, onChange, onClose }: Props) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<SettingsTab>("GENERAL");
  const update = (patch: Partial<TContractAuthoringSettings>) => onChange({ ...value, ...patch });

  return (
    <ModalCore isOpen handleClose={onClose} position={EModalPosition.CENTER} width={EModalWidth.XXXXL}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t("file_library.contracts.workflow.settings.aria_label")}
        className="shadow-2xl flex max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-xl border border-subtle bg-surface-1"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <aside className="w-52 shrink-0 border-r border-subtle bg-layer-1 p-3">
          <p className="px-2 py-2 text-14 font-semibold">{t("file_library.contracts.workflow.settings.title")}</p>
          <nav className="mt-2 space-y-1">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-13 ${
                    activeTab === tab.id
                      ? "bg-accent-primary/10 font-medium text-accent-primary"
                      : "hover:bg-layer-1-hover"
                  }`}
                >
                  <Icon className="size-4" /> {t(tab.labelKey)}
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between border-b border-subtle px-5 py-4">
            <div>
              <h2 className="text-15 font-semibold">
                {t(
                  tabs.find((tab) => tab.id === activeTab)?.labelKey ?? "file_library.contracts.workflow.settings.title"
                )}
              </h2>
              <p className="mt-0.5 text-13 text-tertiary">
                {t("file_library.contracts.workflow.settings.description")}
              </p>
            </div>
            <button type="button" className="rounded p-1.5 hover:bg-layer-1-hover" onClick={onClose}>
              <X className="size-4" />
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {activeTab === "GENERAL" ? (
              <div className="space-y-5">
                <section className="grid grid-cols-2 gap-4">
                  <ContractField label={t("file_library.contracts.workflow.settings.timezone")}>
                    <ContractInput
                      value={value.timezone}
                      onChange={(event) => update({ timezone: event.target.value })}
                    />
                  </ContractField>
                  <ContractField label={t("file_library.contracts.workflow.settings.date_format")}>
                    <ContractSelect
                      value={value.dateFormat}
                      onChange={(dateFormat) => update({ dateFormat })}
                      options={[
                        { value: "yyyy-MM-dd hh:mm a", label: "2026-07-31 07:30 PM" },
                        { value: "dd/MM/yyyy", label: "31/07/2026" },
                        { value: "MM/dd/yyyy", label: "07/31/2026" },
                        { value: "dd MMMM yyyy", label: "31 julio 2026" },
                      ]}
                    />
                  </ContractField>
                  <ContractField label={t("file_library.contracts.workflow.settings.language")}>
                    <ContractSelect
                      value={value.language}
                      onChange={(language) => update({ language })}
                      options={[
                        { value: "es", label: t("file_library.contracts.workflow.settings.spanish") },
                        { value: "en", label: t("file_library.contracts.workflow.settings.english") },
                      ]}
                    />
                  </ContractField>
                  <ContractField label={t("file_library.contracts.workflow.settings.distribution")}>
                    <ContractSelect
                      value={value.distributionMethod}
                      onChange={(distributionMethod: "EMAIL" | "NONE") => update({ distributionMethod })}
                      options={[
                        { value: "EMAIL", label: t("file_library.contracts.workflow.settings.send_email") },
                        { value: "NONE", label: t("file_library.contracts.workflow.settings.no_auto_send") },
                      ]}
                    />
                  </ContractField>
                </section>
                <ContractField label={t("file_library.contracts.workflow.settings.redirect_url")}>
                  <ContractInput
                    type="url"
                    placeholder={t("file_library.contracts.workflow.settings.redirect_placeholder")}
                    value={value.redirectUrl}
                    onChange={(event) => update({ redirectUrl: event.target.value })}
                  />
                </ContractField>
                <ContractField label={t("file_library.contracts.workflow.distribute.reply_to")}>
                  <ContractInput
                    type="email"
                    placeholder={t("file_library.contracts.workflow.settings.reply_to_placeholder")}
                    value={value.emailReplyTo}
                    onChange={(event) => update({ emailReplyTo: event.target.value })}
                  />
                </ContractField>
              </div>
            ) : null}

            {activeTab === "REMINDERS" ? (
              <div className="space-y-5">
                <PeriodEditor
                  label={t("file_library.contracts.workflow.settings.first_reminder")}
                  value={value.reminderSettings.sendAfter}
                  onChange={(next) => update({ reminderSettings: { ...value.reminderSettings, sendAfter: next } })}
                />
                <PeriodEditor
                  label={t("file_library.contracts.workflow.settings.repeat_every")}
                  value={value.reminderSettings.repeatEvery}
                  onChange={(next) => update({ reminderSettings: { ...value.reminderSettings, repeatEvery: next } })}
                />
                <PeriodEditor
                  label={t("file_library.contracts.workflow.settings.expiration")}
                  value={value.envelopeExpirationPeriod}
                  allowYear
                  onChange={(next) => update({ envelopeExpirationPeriod: next })}
                />
              </div>
            ) : null}

            {activeTab === "NOTIFICATIONS" ? (
              <div className="grid grid-cols-2 gap-3">
                {emailOptions.map((option) => (
                  <label
                    key={option.key}
                    className="flex items-center gap-3 rounded-lg border border-subtle p-3 text-13"
                  >
                    <input
                      type="checkbox"
                      checked={value.emailSettings[option.key]}
                      onChange={(event) =>
                        update({ emailSettings: { ...value.emailSettings, [option.key]: event.target.checked } })
                      }
                    />
                    {t(option.labelKey)}
                  </label>
                ))}
              </div>
            ) : null}

            {activeTab === "SECURITY" ? (
              <div className="space-y-4">
                <p className="text-13 text-tertiary">
                  {t("file_library.contracts.workflow.settings.signature_methods")}
                </p>
                <Toggle
                  label={t("file_library.contracts.workflow.settings.typed_signature")}
                  checked={value.typedSignatureEnabled}
                  onChange={(checked) => update({ typedSignatureEnabled: checked })}
                />
                <Toggle
                  label={t("file_library.contracts.workflow.settings.draw_signature")}
                  checked={value.drawSignatureEnabled}
                  onChange={(checked) => update({ drawSignatureEnabled: checked })}
                />
                <Toggle
                  label={t("file_library.contracts.workflow.settings.upload_signature")}
                  checked={value.uploadSignatureEnabled}
                  onChange={(checked) => update({ uploadSignatureEnabled: checked })}
                />
                <p className="rounded-md bg-layer-1 p-3 text-11 text-tertiary">
                  {t("file_library.contracts.workflow.settings.enterprise_notice")}
                </p>
              </div>
            ) : null}
          </div>

          <footer className="flex justify-end border-t border-subtle px-5 py-3">
            <Button type="button" variant="primary" size="sm" onClick={onClose}>
              {t("file_library.contracts.workflow.common.done")}
            </Button>
          </footer>
        </div>
      </section>
    </ModalCore>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between rounded-lg border border-subtle p-3 text-13">
      {label}
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

type Period =
  | { disabled: true }
  | { unit: "day" | "week" | "month"; amount: number }
  | { unit: "day" | "week" | "month" | "year"; amount: number };

function PeriodEditor<TPeriod extends Period>({
  label,
  value,
  allowYear = false,
  onChange,
}: {
  label: string;
  value: TPeriod;
  allowYear?: boolean;
  onChange: (value: TPeriod) => void;
}) {
  const { t } = useTranslation();
  const disabled = "disabled" in value;
  return (
    <section className="rounded-lg border border-subtle p-4">
      <label className="flex items-center justify-between text-13 font-medium">
        {label}
        <input
          type="checkbox"
          checked={!disabled}
          onChange={(event) =>
            onChange((event.target.checked ? { amount: 1, unit: "day" } : { disabled: true }) as TPeriod)
          }
        />
      </label>
      {!disabled ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <ContractInput
            type="number"
            min={1}
            value={value.amount}
            onChange={(event) => onChange({ ...value, amount: Math.max(1, Number(event.target.value)) } as TPeriod)}
          />
          <ContractSelect
            value={value.unit}
            onChange={(unit) => onChange({ ...value, unit } as TPeriod)}
            options={[
              { value: "day", label: t("file_library.contracts.workflow.settings.days") },
              { value: "week", label: t("file_library.contracts.workflow.settings.weeks") },
              { value: "month", label: t("file_library.contracts.workflow.settings.months") },
              ...(allowYear ? [{ value: "year", label: t("file_library.contracts.workflow.settings.years") }] : []),
            ]}
          />
        </div>
      ) : null}
    </section>
  );
}
