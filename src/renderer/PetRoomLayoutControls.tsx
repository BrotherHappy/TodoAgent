import type { PetDecorationPlacement } from "../shared/pet-types";
import {
  PET_ROOM_DECORATION_DEFAULTS,
  PET_ROOM_DECORATION_IDS,
  PET_ROOM_DECORATION_LABELS,
  clampPetDecorationPlacement,
  type PetRoomDecorationId,
} from "./pet-room-layout";

type Placement = Required<PetDecorationPlacement>;

interface PetRoomLayoutControlsProps {
  decorations: readonly string[];
  positions: Record<PetRoomDecorationId, Placement>;
  disabled?: boolean;
  onChange: (positions: Record<PetRoomDecorationId, Placement>) => void;
}

const STEP = 6;

export function PetRoomLayoutControls({
  decorations,
  positions,
  disabled = false,
  onChange,
}: PetRoomLayoutControlsProps) {
  const active = PET_ROOM_DECORATION_IDS.filter((id) => decorations.includes(id));

  const change = (id: PetRoomDecorationId, patch: Partial<Placement>) => {
    const current = positions[id];
    onChange({
      ...positions,
      [id]: clampPetDecorationPlacement(
        { ...current, ...patch },
        PET_ROOM_DECORATION_DEFAULTS[id],
      ),
    });
  };

  const reset = () => {
    if (disabled) return;
    onChange({ ...positions, ...Object.fromEntries(active.map((id) => [id, PET_ROOM_DECORATION_DEFAULTS[id]])) } as Record<PetRoomDecorationId, Placement>);
  };

  return (
    <fieldset className="pet-room-layout-controls" disabled={disabled}>
      <legend>位置与大小</legend>
      <p className="pet-room-layout-hint">
        用方向键把摆件放到顺手的位置，也可以调整大小。只保存在本机。
      </p>
      {active.length ? (
        <div className="pet-room-layout-list">
          {active.map((id) => {
            const placement = positions[id];
            const label = PET_ROOM_DECORATION_LABELS[id];
            return (
              <div className="pet-room-layout-row" key={id}>
                <strong>{label}</strong>
                <div className="pet-room-layout-nudge" role="group" aria-label={`${label}位置`}>
                  <button type="button" aria-label={`${label}上移`} title="上移" onClick={() => change(id, { y: placement.y - STEP })}>↑</button>
                  <button type="button" aria-label={`${label}左移`} title="左移" onClick={() => change(id, { x: placement.x - STEP })}>←</button>
                  <button type="button" aria-label={`${label}下移`} title="下移" onClick={() => change(id, { y: placement.y + STEP })}>↓</button>
                  <button type="button" aria-label={`${label}右移`} title="右移" onClick={() => change(id, { x: placement.x + STEP })}>→</button>
                </div>
                <label className="pet-room-layout-scale">
                  <span>大小</span>
                  <input
                    type="range"
                    min="75"
                    max="130"
                    step="5"
                    value={Math.round(placement.scale * 100)}
                    aria-label={`${label}大小`}
                    onChange={(event) => change(id, { scale: Number(event.target.value) / 100 })}
                  />
                  <output>{Math.round(placement.scale * 100)}%</output>
                </label>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="pet-room-layout-empty">先在上面的摆件里放好一件，再来调整它的位置。</p>
      )}
      <button type="button" className="pet-room-layout-reset" disabled={disabled || !active.length} onClick={reset}>
        恢复默认布局
      </button>
    </fieldset>
  );
}
