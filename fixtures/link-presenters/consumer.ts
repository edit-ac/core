import {
  LinkActivation, LinkPresenterSession, DEFAULT_PRIVATE_LINK_CACHE_POLICY,
  DEFAULT_PUBLIC_LINK_CACHE_POLICY, validPrivateLinkCachePolicy,
  type LinkRequest, type LinkResult, type LinkState, type LinkAction,
  type LinkOutcome, type LinkHostContext, type LinkHostPorts, type LinkTarget,
  type LinkFreshness, type LinkDisplay, type LinkMetadata, type LinkCapabilities,
  type EnrichmentPolicy, type LinkOrigin, type LinkAdmission, type LookupAction,
  type LinkActivationOptions, type ValidatedLinkAction, type LinkPresentation,
  type PublicLinkCachePolicy, type PrivateLinkCachePolicy, type ServiceScope,
  type ReferencePermissionV1, type ReferenceCatalogResultV1,
} from '@edit-ac/core/links';
import {
  bindLinkActivation, linkEnrichment, privateReferenceDisplay,
  LinkActivation as BrowserActivation, LinkPresenterSession as BrowserPresenter,
  type LinkEnrichmentOptions, type LinkEnrichmentFactory,
  type PrivateReferenceDisplayOptions,
} from '@edit-ac/web/links';
import type { ReferenceHostV1 } from '@edit-ac/web/modules';
import { LinkActivation as RootActivation, type EngineHandle } from '@edit-ac/core';
const publicPolicy: Readonly<PublicLinkCachePolicy> = DEFAULT_PUBLIC_LINK_CACHE_POLICY;
const privatePolicy: Readonly<PrivateLinkCachePolicy> = DEFAULT_PRIVATE_LINK_CACHE_POLICY;
const portable = (r: LinkRequest, host: LinkHostContext, outcome: LinkOutcome, ports: LinkHostPorts, options: LinkActivationOptions) => {
  const result: LinkResult = { request: r, outcome };
  const controller: LinkActivation = new BrowserActivation(options);
  const presenter: LinkPresenterSession = new BrowserPresenter(r, 'Shared user text');
  const view: Readonly<LinkPresentation> = presenter.present(result, { ...r, host }, 20);
  const state: LinkState = controller.perform({ kind: 'activate', request: r });
  const action: LinkAction = { kind: 'commit-metadata', request: r, sharedLabel: 'Explicit publication' };
  const signal = new AbortController().signal;
  void ports.privateCatalog(r, signal); void [view, state, action];
  // @ts-expect-error launch actions are typed data, never a shell command
  const shell: ValidatedLinkAction = { kind: 'shell', command: 'open target' };
  // @ts-expect-error unavailable result cannot carry private display fields
  const leak: LinkOutcome = { status: 'forbidden', metadata: { title: 'secret' } };
  // @ts-expect-error validated actions require an admitted locator
  const launch: ValidatedLinkAction = { kind: 'open-private', target: r.target };
  void [shell, leak, launch];
};
const projectCatalog = (host: ReferenceHostV1): ReferenceCatalogResultV1 => host.catalog('configured-id');
const permission: ReferencePermissionV1 = { revision: 'revision1', lookup: true, insert: false };
void [portable, projectCatalog, permission, validPrivateLinkCachePolicy(privatePolicy), publicPolicy,
  bindLinkActivation, linkEnrichment, privateReferenceDisplay, RootActivation];
// Declaration coverage of every exported record family without private paths.
export type ContractTypes = [LinkTarget, LinkFreshness, LinkDisplay, LinkMetadata, LinkCapabilities,
  EnrichmentPolicy, LinkOrigin, LinkAdmission, LookupAction, ServiceScope, EngineHandle,
  LinkEnrichmentOptions, LinkEnrichmentFactory, PrivateReferenceDisplayOptions];
