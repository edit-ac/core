//! Prepared MLS membership mechanics. No production enrollment or resume API.
//! The harness pins a membership authority independently of ordinary writers.
//! Rotation retains operation identities; it never makes a retired sender live.
use super::*;

#[derive(Clone)]
pub(crate) struct Rotation {
    pub from: Context,
    pub next_epoch: u64,
    pub remove: BTreeSet<Vec<u8>>,
}

impl Rotation {
    fn aad(&self) -> Vec<u8> {
        let mut bytes = b"editac/prepared-mls-membership/v1\0".to_vec();
        bytes.extend(self.from.aad([0; 16]));
        bytes.extend(self.next_epoch.to_be_bytes());
        bytes.extend((self.remove.len() as u32).to_be_bytes());
        for key in &self.remove {
            bytes.extend((key.len() as u32).to_be_bytes());
            bytes.extend(key);
        }
        bytes
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum MembershipState {
    Active,
    Revoked,
}

impl<P: OpenMlsProvider> Admission<P> {
    /// Only a prepared authenticated enrollment may pin this authority. An
    /// ordinary writer/read-only member cannot elevate itself during a commit.
    pub(crate) fn fresh_prepared_membership(
        provider: P,
        group: MlsGroup,
        context: Context,
        writers: BTreeSet<Vec<u8>>,
        authority: Vec<u8>,
    ) -> Result<Self, Rejection> {
        let mut admission = Self::fresh_prepared(provider, group, context, writers)?;
        if !admission.writers.contains(&authority) {
            return Err(Rejection::Unauthorized);
        }
        admission.membership_authority = Some(authority);
        Ok(admission)
    }

    fn rotation_members(&self, plan: &Rotation) -> Result<Vec<LeafNodeIndex>, Rejection> {
        self.require_live()?;
        if plan.from != self.context
            || self.context.key_epoch.checked_add(1) != Some(plan.next_epoch)
        {
            return Err(Rejection::Context);
        }
        let authority = self
            .membership_authority
            .as_ref()
            .ok_or(Rejection::Unauthorized)?;
        if plan.remove.contains(authority) || plan.remove.len() > 64 {
            return Err(Rejection::Unauthorized);
        }
        plan.remove
            .iter()
            .map(|key| {
                self.group
                    .members()
                    .find(|member| member.signature_key == *key)
                    .map(|member| member.index)
                    .ok_or(Rejection::Unauthorized)
            })
            .collect()
    }

    fn finish_rotation(&mut self, plan: &Rotation) -> MembershipState {
        self.context.key_epoch = plan.next_epoch;
        self.writers.retain(|key| !plan.remove.contains(key));
        if !self.group.is_active() {
            self.locked = true;
            MembershipState::Revoked
        } else {
            MembershipState::Active
        }
    }

    pub(crate) fn rotate(
        &mut self,
        signer: &SignatureKeyPair,
        plan: &Rotation,
    ) -> Result<Vec<u8>, Rejection> {
        let removed = self.rotation_members(plan)?;
        let authority = self.membership_authority.as_ref().unwrap();
        let own = self.group.own_leaf_node().ok_or(Rejection::Locked)?;
        if own.signature_key().as_slice() != authority || signer.to_public_vec() != *authority {
            return Err(Rejection::Unauthorized);
        }
        self.group.set_aad(plan.aad());
        // Once protocol state is touched any error retires this endpoint. Never
        // clear a pending commit and retry an ambiguous sender state.
        let result = (|| {
            let commit = if removed.is_empty() {
                self.group
                    .self_update(&self.provider, signer, LeafNodeParameters::default())
                    .map_err(|_| Rejection::Authentication)?
                    .into_commit()
            } else {
                self.group
                    .remove_members(&self.provider, signer, &removed)
                    .map_err(|_| Rejection::Authentication)?
                    .0
            };
            let wire = commit
                .tls_serialize_detached()
                .map_err(|_| Rejection::Authentication)?;
            if wire.len() > MAX_ENVELOPE {
                return Err(Rejection::Bounds);
            }
            self.group
                .merge_pending_commit(&self.provider)
                .map_err(|_| Rejection::Authentication)?;
            self.finish_rotation(plan);
            Ok(wire)
        })();
        if result.is_err() {
            self.locked = true;
        }
        result
    }

    pub(crate) fn receive_rotation(
        &mut self,
        plan: &Rotation,
        wire: &[u8],
    ) -> Result<MembershipState, Rejection> {
        let expected: BTreeSet<_> = self.rotation_members(plan)?.into_iter().collect();
        if wire.len() < 4 || wire.len() > MAX_ENVELOPE || wire[..4] != [0, 1, 0, 2] {
            return Err(Rejection::Bounds);
        }
        let result = (|| {
            let message =
                MlsMessageIn::tls_deserialize_exact(wire).map_err(|_| Rejection::Bounds)?;
            let message = message
                .try_into_protocol_message()
                .map_err(|_| Rejection::Unsupported)?;
            if message.group_id().as_slice() != self.context.document
                || message.epoch().as_u64() != self.context.key_epoch
            {
                return Err(Rejection::Context);
            }
            let processed = self
                .group
                .process_message(&self.provider, message)
                .map_err(|_| Rejection::Authentication)?;
            let Sender::Member(index) = processed.sender() else {
                return Err(Rejection::Unauthorized);
            };
            let sender = self
                .group
                .members()
                .find(|m| m.index == *index)
                .ok_or(Rejection::Unauthorized)?;
            if Some(&sender.signature_key) != self.membership_authority.as_ref()
                || &sender.credential != processed.credential()
                || processed.aad() != plan.aad()
            {
                return Err(Rejection::Unauthorized);
            }
            let ProcessedMessageContent::StagedCommitMessage(commit) = processed.into_content()
            else {
                return Err(Rejection::Unsupported);
            };
            let actual: BTreeSet<_> = commit
                .remove_proposals()
                .map(|p| p.remove_proposal().removed())
                .collect();
            // No additions, PSKs, updates or extensions may hitchhike on this
            // narrowly authorized removal/epoch-only boundary.
            if actual != expected
                || commit.queued_proposals().count() != expected.len()
                || commit.epoch().as_u64() != plan.next_epoch
                || commit.update_path_leaf_node().is_none_or(|leaf| {
                    Some(&leaf.signature_key().as_slice().to_vec())
                        != self.membership_authority.as_ref()
                        || leaf.credential() != &sender.credential
                })
            {
                return Err(Rejection::Unauthorized);
            }
            self.group
                .merge_staged_commit(&self.provider, *commit)
                .map_err(|_| Rejection::Authentication)?;
            Ok(self.finish_rotation(plan))
        })();
        if result.is_err() {
            self.locked = true;
        }
        result
    }
}
