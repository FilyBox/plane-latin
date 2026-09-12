import { PaymentsSidePanel } from "./side-panel";
export function BudgetPeekPanel(props: {
  children: React.ReactNode;
  title: string;
  description?: string;
  onClose: () => void;
}) {
  return (
    <PaymentsSidePanel {...props} isOpen>
      <div className="min-h-0 flex-1 overflow-auto">{props.children}</div>
    </PaymentsSidePanel>
  );
}
