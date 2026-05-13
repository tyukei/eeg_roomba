interface SliderProps {
  label: string;
  min: number; max: number; step: number;
  value: number;
  onChange: (v: number) => void;
  unit?: string;
  hint?: string;
}

export function Slider({ label, min, max, step, value, onChange, unit, hint }: SliderProps) {
  return (
    <div className="slider-row">
      <div className="slider-head">
        <label>{label}{hint && <small> · {hint}</small>}</label>
        <input
          type="number"
          min={min} max={max} step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="slider-num"
        />
        {unit && <span className="slider-unit">{unit}</span>}
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
