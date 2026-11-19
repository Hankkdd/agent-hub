import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

export function PhoneBack({ onBack }: { onBack: () => void }) {
  return <Button size="icon" variant="ghost" className="shrink-0 md:hidden" aria-label={t("navigation.backToList")} title={t("navigation.backToList")} onClick={onBack}><ArrowLeft /></Button>;
}
