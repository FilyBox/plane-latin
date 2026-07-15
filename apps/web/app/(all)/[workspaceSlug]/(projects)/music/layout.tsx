import { Outlet } from "react-router";
import { AppHeader } from "@/components/core/app-header";
import { ContentWrapper } from "@/components/core/content-wrapper";
import { MusicCatalogHeader } from "./header";

export default function MusicCatalogLayout() {
  return (
    <>
      <AppHeader header={<MusicCatalogHeader />} />
      <ContentWrapper>
        <Outlet />
      </ContentWrapper>
    </>
  );
}
