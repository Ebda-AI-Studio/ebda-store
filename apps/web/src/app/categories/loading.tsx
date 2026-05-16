import { ShopChrome } from '../../components';

export default function Loading() {
  return (
    <ShopChrome>
      <div data-loading className="flex min-h-[50vh] items-center justify-center flex-1">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    </ShopChrome>
  );
}
