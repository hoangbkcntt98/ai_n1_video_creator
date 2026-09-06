"use client";

import DatePicker from "react-datepicker";

type Props = {
  value: string;
  onChange: (value: string) => void;
  name?: string;
  placeholder?: string;
};

function parseValue(value: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function formatLocalValue(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function SchedulePicker({
  value,
  onChange,
  name,
  placeholder = "Choose publishing date and time",
}: Props) {
  return (
    <>
      <DatePicker
        selected={parseValue(value)}
        onChange={(date: Date | null) => onChange(date ? formatLocalValue(date) : "")}
        showTimeSelect
        timeIntervals={15}
        timeCaption="Time"
        dateFormat="dd/MM/yyyy HH:mm"
        placeholderText={placeholder}
        isClearable
        popperPlacement="bottom-start"
        autoComplete="off"
      />
      {name ? <input type="hidden" name={name} value={value} /> : null}
    </>
  );
}
