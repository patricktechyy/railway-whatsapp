import type { List } from '../types'
import { MenuItem, Popover, usePopover } from './Popover'

/** ⋯ on a list: Edit or Delete. Also opens on right-click of the list's row (see Sidebar). */
export function ListMenu({ list, onEdit, onDelete, className = 'icon-btn sm edit' }: {
  list: List
  onEdit: () => void
  onDelete: () => void
  className?: string
}) {
  const menu = usePopover()
  return (
    <>
      <button ref={menu.ref} className={className} onClick={menu.toggle} aria-label={`More for list ${list.name}`} aria-haspopup="menu" aria-expanded={menu.open} title="Edit or delete this list" data-list-menu={list.id}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="5" cy="10" r="1.2" /><circle cx="10" cy="10" r="1.2" /><circle cx="15" cy="10" r="1.2" /></svg>
      </button>
      {menu.open && (
        <Popover anchor={menu.anchor} onClose={menu.close} label={`List ${list.name}`} width={210}>
          <div className="menu" role="menu">
            <MenuItem icon="✏️" label="Edit list" onClick={() => { menu.close(); onEdit() }} />
            <MenuItem icon="🗑" label="Delete list…" danger onClick={() => { menu.close(); onDelete() }} />
          </div>
        </Popover>
      )}
    </>
  )
}
