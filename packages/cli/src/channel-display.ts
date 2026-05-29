export interface DmChannelMember {
  member_id: string;
  member_type: string;
}

export function findSingleOtherDmMember(currentMemberId: string, members: DmChannelMember[]): DmChannelMember | null {
  const others = members.filter((member) => member.member_id !== currentMemberId);
  return others.length === 1 ? others[0] : null;
}
