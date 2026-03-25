import clsx from "clsx";

type Props = {
  alt: string;
  src?: string | null;
  className?: string;
  label?: string;
};

export function MediaPoster({ alt, src, className, label }: Props) {
  return (
    <div className={clsx("media-poster", className)}>
      {src ? <img alt={alt} loading="lazy" src={src} /> : null}
      <div className={clsx("media-poster-overlay", !src && "is-visible")}>
        <span>{label ?? "Preview unavailable"}</span>
      </div>
    </div>
  );
}
