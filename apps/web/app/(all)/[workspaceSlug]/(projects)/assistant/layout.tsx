import { Outlet } from "react-router";
import { AppHeader } from "@/components/core/app-header";
import { ContentWrapper } from "@/components/core/content-wrapper";
import { AssistantHeader } from "./header";

export default function AssistantLayout() {
  return (
    <>
      <AppHeader header={<AssistantHeader />} />
      <ContentWrapper>
        <Outlet />
      </ContentWrapper>
    </>
  );
}
