import { useEffect, useMemo, useState } from "react";
import {
  idlePetActions,
  petActionLabels,
  PET_IDLE_COOLDOWN_MAX_MS,
  PET_IDLE_COOLDOWN_MIN_MS,
  type PetIdleAction,
} from "./pet-behavior";
import {
  type InstalledPetActionPack,
  validatePetActionPack,
} from "./pet-action-packs";

export interface PetActionPackEditorProps {
  activePack?: InstalledPetActionPack;
  disabled?: boolean;
  onInstall: (pack: InstalledPetActionPack) => void;
}

const defaultActions: PetIdleAction[] = ["idle", "stretch", "read", "drink", "peek"];
const defaultCooldownSeconds = String(PET_IDLE_COOLDOWN_MIN_MS / 1000);
const defaultActionWeights = (): Record<PetIdleAction, number> =>
  Object.fromEntries(idlePetActions.map((action) => [action, 3])) as Record<PetIdleAction, number>;

/**
 * A safe visual editor for declarative action packs. It only emits the same
 * validated shape accepted by the JSON importer; no script or external asset
 * can enter the renderer through this surface.
 */
export function PetActionPackEditor({
  activePack,
  disabled = false,
  onInstall,
}: PetActionPackEditorProps) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<PetIdleAction[]>(defaultActions);
  const [cooldownSeconds, setCooldownSeconds] = useState(defaultCooldownSeconds);
  const [actionWeights, setActionWeights] = useState<Record<PetIdleAction, number>>(defaultActionWeights);
  const [error, setError] = useState("");

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const reset = () => {
    setId("");
    setName("");
    setDescription("");
    setSelected(defaultActions);
    setCooldownSeconds(defaultCooldownSeconds);
    setActionWeights(defaultActionWeights());
    setError("");
  };

  const loadActive = () => {
    if (!activePack) return;
    setId(activePack.id);
    setName(activePack.name);
    setDescription(activePack.description);
    setSelected([...activePack.idleActions]);
    setCooldownSeconds(String(Math.round((activePack.cooldownMs ?? PET_IDLE_COOLDOWN_MIN_MS) / 1000)));
    setActionWeights({ ...defaultActionWeights(), ...(activePack.actionWeights ?? {}) });
    setError("");
  };

  useEffect(() => {
    if (!activePack) return;
    // Keep the editor useful after selecting a pack in the adjacent picker,
    // but do not overwrite edits already being made in the form.
    if (!id && !name) loadActive();
    // The selected pack identity is the only dependency that should trigger
    // this synchronization; the form fields intentionally remain local.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePack?.id]);

  const toggle = (action: PetIdleAction) => {
    setSelected((current) => {
      if (current.includes(action)) {
        if (current.length <= 1) return current;
        return current.filter((item) => item !== action);
      }
      if (current.length >= 20) return current;
      return [...current, action];
    });
    setError("");
  };

  const submit = () => {
    const result = validatePetActionPack({
      id,
      name,
      description,
      idleActions: selected,
      cooldownMs: Number(cooldownSeconds) * 1000,
      actionWeights: Object.fromEntries(
        selected.map((action) => [action, actionWeights[action] ?? 3]),
      ),
    });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onInstall(result.pack);
    setError("");
  };

  return (
    <div className="pet-action-pack-editor" aria-label="动作包可视化编辑器">
      <div className="pet-action-pack-editor-heading">
        <div>
          <strong>可视化编辑器</strong>
          <p>勾选已有动作，组合一个只在本机运行的陪伴节奏。</p>
        </div>
        <span>{selected.length}/20</span>
      </div>
      <div className="pet-action-pack-editor-fields">
        <label>
          <span>包 ID</span>
          <input
            className="settings-input"
            value={id}
            disabled={disabled}
            onChange={(event) => { setId(event.target.value); setError(""); }}
            placeholder="cozy-reading"
            maxLength={40}
          />
        </label>
        <label>
          <span>名称</span>
          <input
            className="settings-input"
            value={name}
            disabled={disabled}
            onChange={(event) => { setName(event.target.value); setError(""); }}
            placeholder="安静阅读"
            maxLength={40}
          />
        </label>
      </div>
      <label className="pet-action-pack-editor-description">
        <span>说明</span>
        <input
          className="settings-input"
          value={description}
          disabled={disabled}
          onChange={(event) => { setDescription(event.target.value); setError(""); }}
          placeholder="更多阅读和休息动作"
          maxLength={160}
        />
      </label>
      <label className="pet-action-pack-cooldown">
        <span>动作冷却（秒）</span>
        <input
          className="settings-input"
          aria-label="动作冷却（秒）"
          type="number"
          min={PET_IDLE_COOLDOWN_MIN_MS / 1000}
          max={PET_IDLE_COOLDOWN_MAX_MS / 1000}
          step={1}
          value={cooldownSeconds}
          disabled={disabled}
          onChange={(event) => { setCooldownSeconds(event.target.value); setError(""); }}
        />
        <small>每次待机动作至少间隔 {PET_IDLE_COOLDOWN_MIN_MS / 1000}–{PET_IDLE_COOLDOWN_MAX_MS / 1000} 秒，避免桌面过度打扰。</small>
      </label>
      <div className="pet-action-pack-action-grid" role="group" aria-label="选择待机动作">
        {idlePetActions.map((action) => (
          <label className={`pet-action-pack-action ${selectedSet.has(action) ? "is-selected" : ""}`} key={action}>
            <input
              type="checkbox"
              checked={selectedSet.has(action)}
              disabled={disabled || (selectedSet.has(action) && selected.length <= 1)}
              onChange={() => toggle(action)}
            />
            <span>{petActionLabels[action]}</span>
          </label>
        ))}
      </div>
      <div className="pet-action-pack-frequency" role="group" aria-label="动作出现频率">
        <div className="pet-action-pack-frequency-heading">
          <strong>出现频率</strong>
          <span>1 偶尔 · 3 正常 · 5 常见</span>
        </div>
        {selected.map((action) => (
          <label key={action} className="pet-action-pack-frequency-row">
            <span>{petActionLabels[action]}</span>
            <input
              type="range"
              min={1}
              max={5}
              step={1}
              aria-label={`${petActionLabels[action]}出现频率`}
              value={actionWeights[action] ?? 3}
              disabled={disabled}
              onChange={(event) => {
                const value = Number(event.target.value);
                setActionWeights((current) => ({ ...current, [action]: value }));
                setError("");
              }}
            />
            <output>{actionWeights[action] ?? 3}</output>
          </label>
        ))}
      </div>
      <div className="settings-actions pet-action-pack-editor-actions">
        <button type="button" className="soft-button" disabled={disabled || !activePack} onClick={loadActive}>载入当前包</button>
        <button type="button" className="ghost-button" disabled={disabled} onClick={reset}>清空重来</button>
        <span className="action-spacer" />
        <button type="button" className="primary-button" disabled={disabled || !id.trim() || !name.trim()} onClick={submit}>安装并启用</button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
