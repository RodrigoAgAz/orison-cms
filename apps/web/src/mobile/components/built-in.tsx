import { BrandMark } from "./icons";

/** Stand-in for the box's built-in standby video: it isn't in the library, so there is nothing to watch. */
export function BuiltInStill() {
  return (
    <div className="m-player m-player-builtin" data-testid="built-in-still">
      <span className="m-poster m-poster-wide m-poster-builtin">
        <BrandMark size={44} />
        <span>Built-in video</span>
      </span>
    </div>
  );
}
