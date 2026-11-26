import { Link } from "react-router";
import LangText from "@app/components/LangText";

/** A card's author name: a link to the author's profile when the card has its URL. */
export default function CardAuthor({ name, url }: { name: string; url?: string }) {
  return url ? (
    <Link
      to={url}
      className="rounded outline-none hover:text-white hover:underline focus-visible:text-white focus-visible:underline"
    >
      <LangText text={name} />
    </Link>
  ) : (
    <span>
      <LangText text={name} />
    </span>
  );
}
