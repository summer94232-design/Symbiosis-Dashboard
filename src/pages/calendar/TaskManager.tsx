import { useState, useEffect } from 'react'
import { addDoc, getDocs, updateDoc, deleteDoc, orderBy, query, where, writeBatch } from 'firebase/firestore'
import { investDB } from '../../lib/firebase'
import { userCol, userDoc } from '../../lib/userDB'
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Plus, Trash2, X, Check, ChevronDown, ChevronRight, GripVertical, Pencil, Calendar, Tag, FolderOpen } from 'lucide-react'

interface Task {
    id: string
    title: string
    done: boolean
    priority: 'high' | 'medium' | 'low'
    dueDate?: string
    tag?: string
    projectId?: string
    order: number
    createdAt: string
    note?: string
}

interface Project {
    id: string
    title: string
    color: string
    order: number
    createdAt: string
}

const PRIORITY_COLORS = { high: 'var(--c-danger)', medium: 'var(--c-warning)', low: 'var(--c-positive)' }
const PRIORITY_LABELS = { high: '高', medium: '中', low: '低' }
const PROJECT_COLORS = ['var(--c-accent)', 'var(--c-positive)', 'var(--c-warning)', '#a78bfa', 'var(--c-danger)', '#00b4d8']
const DEFAULT_TAGS = ['工作', '投資', '生活', '學習', '健康', '其他']

const card: React.CSSProperties = { backgroundColor: 'var(--c-sidebar)', border: '1px solid var(--c-border)', borderRadius: '12px', padding: '20px' }
const inp: React.CSSProperties = { backgroundColor: 'var(--c-bg)', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '8px 12px', color: 'var(--c-text)', fontSize: '14px', width: '100%', outline: 'none', boxSizing: 'border-box' }
const lbl: React.CSSProperties = { fontSize: '12px', color: 'var(--c-muted)', display: 'block', marginBottom: '4px' }
const btn = (color: string): React.CSSProperties => ({ backgroundColor: color, border: 'none', borderRadius: '8px', padding: '8px 16px', color: '#fff', fontSize: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' })

// 可拖曳任務元件
function SortableTask({ task, onToggle, onDelete, onEdit }: {
    task: Task
    onToggle: (id: string, done: boolean) => void
    onDelete: (id: string) => void
    onEdit: (task: Task) => void
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id })
    const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }

    // 與 Dashboard / DailyBrief 統一口徑：字串比較，今天到期不算逾期
    const isOverdue = task.dueDate && !task.done && task.dueDate < new Date().toISOString().split('T')[0]

    return (
        <div ref={setNodeRef} style={{ ...style, display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '10px 12px', backgroundColor: 'var(--c-bg)', borderRadius: '8px', border: '1px solid var(--c-border)', marginBottom: '6px' }}>
            {/* 拖曳把手 */}
            <button {...attributes} {...listeners} style={{ background: 'none', border: 'none', color: 'var(--c-border)', cursor: 'grab', padding: '2px', display: 'flex', flexShrink: 0, marginTop: '2px' }}>
                <GripVertical size={14} />
            </button>

            {/* 完成勾選 */}
            <button onClick={() => onToggle(task.id, !task.done)}
                style={{ width: '18px', height: '18px', borderRadius: '50%', border: `2px solid ${task.done ? 'var(--c-positive)' : PRIORITY_COLORS[task.priority]}`, backgroundColor: task.done ? 'var(--c-positive)' : 'transparent', cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: '2px' }}>
                {task.done && <Check size={10} color="#fff" />}
            </button>

            {/* 內容 */}
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '14px', color: task.done ? 'var(--c-muted)' : 'var(--c-text)', textDecoration: task.done ? 'line-through' : 'none', lineHeight: 1.4 }}>
                    {task.title}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' }}>
                    {task.tag && (
                        <span style={{ fontSize: '11px', backgroundColor: 'color-mix(in srgb, var(--c-accent) 10%, transparent)', color: 'var(--c-accent)', borderRadius: '10px', padding: '1px 6px' }}>
                            #{task.tag}
                        </span>
                    )}
                    {task.dueDate && (
                        <span style={{ fontSize: '11px', color: isOverdue ? 'var(--c-danger)' : 'var(--c-muted)', display: 'flex', alignItems: 'center', gap: '3px' }}>
                            <Calendar size={10} />{task.dueDate}
                            {isOverdue && ' ⚠️'}
                        </span>
                    )}
                    <span style={{ fontSize: '11px', backgroundColor: `${PRIORITY_COLORS[task.priority]}18`, color: PRIORITY_COLORS[task.priority], borderRadius: '10px', padding: '1px 6px' }}>
                        {PRIORITY_LABELS[task.priority]}
                    </span>
                </div>
                {task.note && <div style={{ fontSize: '12px', color: 'var(--c-muted)', marginTop: '4px', lineHeight: 1.5 }}>{task.note}</div>}
            </div>

            {/* 操作按鈕 */}
            <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                <button onClick={() => onEdit(task)} style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer', padding: '2px' }}><Pencil size={13} /></button>
                <button onClick={() => onDelete(task.id)} style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer', padding: '2px' }}><Trash2 size={13} /></button>
            </div>
        </div>
    )
}

export default function TaskManager() {
    const [tasks, setTasks] = useState<Task[]>([])
    const [projects, setProjects] = useState<Project[]>([])
    const [selectedProject, setSelectedProject] = useState<string | null>(null)
    const [selectedTag, setSelectedTag] = useState<string>('')
    const [showDone, setShowDone] = useState(false)
    const [showTaskForm, setShowTaskForm] = useState(false)
    const [showProjectForm, setShowProjectForm] = useState(false)
    const [editingTask, setEditingTask] = useState<Task | null>(null)
    const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
    const [taskForm, setTaskForm] = useState({ title: '', priority: 'medium' as Task['priority'], dueDate: '', tag: '', projectId: '', note: '' })
    const [projectForm, setProjectForm] = useState({ title: '', color: PROJECT_COLORS[0] })

    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

    const loadTasks = async () => {
        const snap = await getDocs(query(userCol(investDB, 'tasks'), orderBy('order', 'asc')))
        setTasks(snap.docs.map(d => ({ id: d.id, ...d.data() } as Task)))
    }

    const loadProjects = async () => {
        const snap = await getDocs(query(userCol(investDB, 'taskProjects'), orderBy('order', 'asc')))
        setProjects(snap.docs.map(d => ({ id: d.id, ...d.data() } as Project)))
    }

    useEffect(() => { loadTasks(); loadProjects() }, [])

    // 新增/編輯任務
    const handleSaveTask = async () => {
        if (!taskForm.title.trim()) return
        const now = new Date().toISOString()
        if (editingTask) {
            await updateDoc(userDoc(investDB, 'tasks', editingTask.id), {
                title: taskForm.title, priority: taskForm.priority,
                dueDate: taskForm.dueDate || null, tag: taskForm.tag || null,
                projectId: taskForm.projectId || null, note: taskForm.note || null
            })
        } else {
            const maxOrder = tasks.length > 0 ? Math.max(...tasks.map(t => t.order)) + 1 : 0
            await addDoc(userCol(investDB, 'tasks'), {
                title: taskForm.title, done: false, priority: taskForm.priority,
                dueDate: taskForm.dueDate || null, tag: taskForm.tag || null,
                projectId: taskForm.projectId || null, note: taskForm.note || null,
                order: maxOrder, createdAt: now
            })
        }
        setTaskForm({ title: '', priority: 'medium', dueDate: '', tag: '', projectId: '', note: '' })
        setShowTaskForm(false); setEditingTask(null); loadTasks()
    }

    const handleEditTask = (task: Task) => {
        setEditingTask(task)
        setTaskForm({
            title: task.title, priority: task.priority,
            dueDate: task.dueDate || '', tag: task.tag || '',
            projectId: task.projectId || '', note: task.note || ''
        })
        setShowTaskForm(true)
    }

    const handleToggleTask = async (id: string, done: boolean) => {
        await updateDoc(userDoc(investDB, 'tasks', id), { done }); loadTasks()
    }

    const handleDeleteTask = async (id: string) => {
        if (!confirm('確定要刪除此任務？')) return
        await deleteDoc(userDoc(investDB, 'tasks', id)); loadTasks()
    }

    // 新增專案
    const handleSaveProject = async () => {
        if (!projectForm.title.trim()) return
        const maxOrder = projects.length > 0 ? Math.max(...projects.map(p => p.order)) + 1 : 0
        await addDoc(userCol(investDB, 'taskProjects'), {
            title: projectForm.title, color: projectForm.color,
            order: maxOrder, createdAt: new Date().toISOString()
        })
        setProjectForm({ title: '', color: PROJECT_COLORS[0] })
        setShowProjectForm(false); loadProjects()
    }

    const handleDeleteProject = async (id: string) => {
        if (!confirm('確定要刪除此專案？專案內的任務也會一併刪除。')) return

        // 直接從 Firestore 查詢屬於此專案的所有任務，不依賴 React state 快照
        const snap = await getDocs(query(userCol(investDB, 'tasks'), where('projectId', '==', id)))

        const batch = writeBatch(investDB)

        // 1. 刪除專案文件
        batch.delete(userDoc(investDB, 'taskProjects', id))

        // 2. 一併刪除該專案下所有子任務
        snap.docs.forEach(d => {
            batch.delete(userDoc(investDB, 'tasks', d.id))
        })

        await batch.commit()

        // 若目前正在檢視此專案，跳回全部任務
        if (selectedProject === id) setSelectedProject(null)

        loadTasks()
        loadProjects()
    }

    // 拖曳排序
    const handleDragEnd = async (event: DragEndEvent) => {
        const { active, over } = event
        if (!over || active.id === over.id) return
        const oldIndex = filteredTasks.findIndex(t => t.id === active.id)
        const newIndex = filteredTasks.findIndex(t => t.id === over.id)
        const newOrder = arrayMove(filteredTasks, oldIndex, newIndex)
        setTasks(prev => {
            const others = prev.filter(t => !newOrder.find(n => n.id === t.id))
            return [...others, ...newOrder.map((t, i) => ({ ...t, order: i }))]
        })
        const batch = writeBatch(investDB)
        newOrder.forEach((t, i) => batch.update(userDoc(investDB, 'tasks', t.id), { order: i }))
        await batch.commit()
    }

    const toggleProject = (id: string) => {
        setExpandedProjects(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id); else next.add(id)
            return next
        })
    }

    // 篩選任務
    const filteredTasks = tasks.filter(t => {
        const matchProject = !selectedProject || t.projectId === selectedProject
        const matchTag = !selectedTag || t.tag === selectedTag
        const matchDone = showDone ? true : !t.done
        return matchProject && matchTag && matchDone
    })

    const todoTasks = filteredTasks.filter(t => !t.done)
    const doneTasks = filteredTasks.filter(t => t.done)
    const allTags = [...new Set(tasks.map(t => t.tag).filter(Boolean) as string[])]
    // 與 Dashboard / DailyBrief 統一口徑：字串比較，今天到期不算逾期
    const todayStr = new Date().toISOString().split('T')[0]
    const overdueCount = tasks.filter(t => !t.done && t.dueDate && t.dueDate < todayStr).length

    return (
        <>
            <style>{`
        .task-form-grid { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
        @media (max-width: 600px) { .task-form-grid { grid-template-columns: 1fr; } }
        .project-row { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 8px; cursor: pointer; font-size: 13px; margin-bottom: 2px; position: relative; }
        .project-row .project-delete { opacity: 0; transition: opacity 0.15s; }
        .project-row:hover .project-delete { opacity: 1; }
      `}</style>

            <div style={{ padding: 'clamp(16px, 3vw, 32px)', maxWidth: '1400px', margin: '0 auto' }}>

                {/* 標題列 */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
                    <div>
                        <h1 style={{ fontSize: 'clamp(18px, 2.5vw, 22px)', fontWeight: 700, color: 'var(--c-text)', margin: 0 }}>任務管理</h1>
                        <p style={{ fontSize: '13px', color: 'var(--c-muted)', margin: '4px 0 0' }}>
                            {todoTasks.length} 個待辦
                            {overdueCount > 0 && <span style={{ color: 'var(--c-danger)', marginLeft: '8px' }}>⚠️ {overdueCount} 個已逾期</span>}
                        </p>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <button onClick={() => { setShowProjectForm(true) }} style={{ ...btn('var(--c-card)'), border: '1px solid var(--c-border)', fontSize: '13px' }}>
                            <FolderOpen size={14} />新增專案
                        </button>
                        <button onClick={() => { setEditingTask(null); setTaskForm({ title: '', priority: 'medium', dueDate: '', tag: '', projectId: selectedProject || '', note: '' }); setShowTaskForm(true) }} style={btn('var(--c-accent)')}>
                            <Plus size={14} />新增任務
                        </button>
                    </div>
                </div>

                <div style={{ display: 'grid', gap: '16px', gridTemplateColumns: '220px 1fr' }}>

                    {/* 左側：專案 + 標籤 */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        <div style={card}>
                            <div style={{ fontSize: '12px', color: 'var(--c-muted)', fontWeight: 600, marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>專案</div>
                            <div
                                onClick={() => setSelectedProject(null)}
                                style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 8px', borderRadius: '8px', cursor: 'pointer', backgroundColor: !selectedProject ? 'color-mix(in srgb, var(--c-accent) 12%, transparent)' : 'transparent', color: !selectedProject ? 'var(--c-accent)' : 'var(--c-muted)', fontSize: '13px', marginBottom: '2px' }}>
                                <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: 'var(--c-accent)', flexShrink: 0 }} />
                                <span style={{ flex: 1 }}>全部任務</span>
                                <span style={{ fontSize: '11px' }}>{tasks.filter(t => !t.done).length}</span>
                            </div>
                            {projects.map(p => (
                                <div key={p.id}
                                    className="project-row"
                                    style={{ backgroundColor: selectedProject === p.id ? `${p.color}18` : 'transparent', color: selectedProject === p.id ? p.color : 'var(--c-muted)' }}
                                    onClick={() => setSelectedProject(selectedProject === p.id ? null : p.id)}>
                                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: p.color, flexShrink: 0 }} />
                                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.title}</span>
                                    <span style={{ fontSize: '11px' }}>{tasks.filter(t => t.projectId === p.id && !t.done).length}</span>
                                    <button onClick={e => { e.stopPropagation(); handleDeleteProject(p.id) }}
                                        className="project-delete"
                                        style={{ background: 'none', border: 'none', color: 'var(--c-danger)', cursor: 'pointer', padding: '2px', display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                                        <Trash2 size={12} />
                                    </button>
                                </div>
                            ))}
                            <button onClick={() => setShowProjectForm(true)}
                                style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px', borderRadius: '8px', border: '1px dashed var(--c-border)', color: 'var(--c-muted)', fontSize: '12px', cursor: 'pointer', background: 'none', width: '100%', marginTop: '4px' }}>
                                <Plus size={12} />新增專案
                            </button>
                        </div>

                        {/* 標籤篩選 */}
                        {allTags.length > 0 && (
                            <div style={card}>
                                <div style={{ fontSize: '12px', color: 'var(--c-muted)', fontWeight: 600, marginBottom: '10px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>標籤</div>
                                <button onClick={() => setSelectedTag('')}
                                    style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 8px', borderRadius: '8px', border: 'none', backgroundColor: !selectedTag ? 'color-mix(in srgb, var(--c-accent) 12%, transparent)' : 'transparent', color: !selectedTag ? 'var(--c-accent)' : 'var(--c-muted)', fontSize: '12px', cursor: 'pointer', width: '100%', marginBottom: '2px' }}>
                                    全部
                                </button>
                                {allTags.map(tag => (
                                    <button key={tag} onClick={() => setSelectedTag(selectedTag === tag ? '' : tag)}
                                        style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 8px', borderRadius: '8px', border: 'none', backgroundColor: selectedTag === tag ? 'color-mix(in srgb, var(--c-accent) 12%, transparent)' : 'transparent', color: selectedTag === tag ? 'var(--c-accent)' : 'var(--c-muted)', fontSize: '12px', cursor: 'pointer', width: '100%', marginBottom: '2px' }}>
                                        <Tag size={11} />#{tag}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* 右側：任務列表 */}
                    <div>
                        {/* 待辦任務 */}
                        <div style={{ ...card, marginBottom: '16px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                                <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--c-text)' }}>待辦 ({todoTasks.length})</span>
                            </div>

                            {todoTasks.length === 0 ? (
                                <div style={{ textAlign: 'center', padding: '32px', color: 'var(--c-muted)', fontSize: '13px' }}>
                                    🎉 沒有待辦任務！
                                </div>
                            ) : (
                                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                                    <SortableContext items={todoTasks.map(t => t.id)} strategy={verticalListSortingStrategy}>
                                        {todoTasks.map(task => (
                                            <SortableTask key={task.id} task={task}
                                                onToggle={handleToggleTask} onDelete={handleDeleteTask} onEdit={handleEditTask} />
                                        ))}
                                    </SortableContext>
                                </DndContext>
                            )}

                            <button onClick={() => { setEditingTask(null); setTaskForm({ title: '', priority: 'medium', dueDate: '', tag: '', projectId: selectedProject || '', note: '' }); setShowTaskForm(true) }}
                                style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px', borderRadius: '8px', border: '1px dashed var(--c-border)', color: 'var(--c-muted)', fontSize: '13px', cursor: 'pointer', background: 'none', width: '100%', marginTop: '8px', justifyContent: 'center' }}>
                                <Plus size={13} />新增任務
                            </button>
                        </div>

                        {/* 已完成 */}
                        <div style={card}>
                            <button onClick={() => setShowDone(v => !v)}
                                style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer', fontSize: '14px', fontWeight: 600, padding: 0, width: '100%' }}>
                                {showDone ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                已完成 ({doneTasks.length})
                            </button>
                            {showDone && doneTasks.length > 0 && (
                                <div style={{ marginTop: '12px' }}>
                                    {doneTasks.map(task => (
                                        <SortableTask key={task.id} task={task}
                                            onToggle={handleToggleTask} onDelete={handleDeleteTask} onEdit={handleEditTask} />
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* 任務表單 Modal */}
            {showTaskForm && (
                <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
                    <div style={{ ...card, width: '100%', maxWidth: '520px', maxHeight: '90vh', overflowY: 'auto' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                            <span style={{ fontSize: '16px', fontWeight: 600, color: 'var(--c-text)' }}>{editingTask ? '編輯任務' : '新增任務'}</span>
                            <button onClick={() => { setShowTaskForm(false); setEditingTask(null) }} style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer' }}><X size={18} /></button>
                        </div>

                        <div className="task-form-grid">
                            <div style={{ gridColumn: 'span 2' }}>
                                <label style={lbl}>任務標題 *</label>
                                <input style={inp} placeholder="輸入任務..." value={taskForm.title}
                                    onChange={e => setTaskForm(f => ({ ...f, title: e.target.value }))}
                                    onKeyDown={e => e.key === 'Enter' && handleSaveTask()} autoFocus />
                            </div>

                            <div>
                                <label style={lbl}>優先級</label>
                                <select style={{ ...inp, cursor: 'pointer' }} value={taskForm.priority}
                                    onChange={e => setTaskForm(f => ({ ...f, priority: e.target.value as Task['priority'] }))}>
                                    <option value="high">🔴 高</option>
                                    <option value="medium">🟡 中</option>
                                    <option value="low">🟢 低</option>
                                </select>
                            </div>

                            <div>
                                <label style={lbl}>截止日期</label>
                                <input type="date" style={inp} value={taskForm.dueDate}
                                    onChange={e => setTaskForm(f => ({ ...f, dueDate: e.target.value }))} />
                            </div>

                            <div>
                                <label style={lbl}>標籤</label>
                                <select style={{ ...inp, cursor: 'pointer' }} value={taskForm.tag}
                                    onChange={e => setTaskForm(f => ({ ...f, tag: e.target.value }))}>
                                    <option value="">無標籤</option>
                                    {DEFAULT_TAGS.map(t => <option key={t} value={t}>{t}</option>)}
                                    {allTags.filter(t => !DEFAULT_TAGS.includes(t)).map(t => <option key={t} value={t}>{t}</option>)}
                                </select>
                            </div>

                            <div>
                                <label style={lbl}>所屬專案</label>
                                <select style={{ ...inp, cursor: 'pointer' }} value={taskForm.projectId}
                                    onChange={e => setTaskForm(f => ({ ...f, projectId: e.target.value }))}>
                                    <option value="">無專案</option>
                                    {projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
                                </select>
                            </div>

                            <div style={{ gridColumn: 'span 2' }}>
                                <label style={lbl}>備註</label>
                                <textarea style={{ ...inp, minHeight: '80px', resize: 'vertical', fontFamily: 'sans-serif' }}
                                    placeholder="任務備註..." value={taskForm.note}
                                    onChange={e => setTaskForm(f => ({ ...f, note: e.target.value }))} />
                            </div>
                        </div>

                        <div style={{ display: 'flex', gap: '8px', marginTop: '20px', justifyContent: 'flex-end' }}>
                            <button style={btn('var(--c-border)')} onClick={() => { setShowTaskForm(false); setEditingTask(null) }}><X size={14} />取消</button>
                            <button style={btn('var(--c-accent)')} onClick={handleSaveTask}>
                                <Check size={14} />{editingTask ? '更新' : '新增'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* 專案表單 Modal */}
            {showProjectForm && (
                <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
                    <div style={{ ...card, width: '100%', maxWidth: '400px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                            <span style={{ fontSize: '16px', fontWeight: 600, color: 'var(--c-text)' }}>新增專案</span>
                            <button onClick={() => setShowProjectForm(false)} style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer' }}><X size={18} /></button>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            <div>
                                <label style={lbl}>專案名稱 *</label>
                                <input style={inp} placeholder="專案名稱" value={projectForm.title}
                                    onChange={e => setProjectForm(f => ({ ...f, title: e.target.value }))}
                                    onKeyDown={e => e.key === 'Enter' && handleSaveProject()} autoFocus />
                            </div>
                            <div>
                                <label style={lbl}>顏色</label>
                                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                                    {PROJECT_COLORS.map(color => (
                                        <button key={color} onClick={() => setProjectForm(f => ({ ...f, color }))}
                                            style={{ width: '28px', height: '28px', borderRadius: '50%', backgroundColor: color, border: projectForm.color === color ? '3px solid #fff' : '3px solid transparent', cursor: 'pointer' }} />
                                    ))}
                                </div>
                            </div>
                        </div>
                        <div style={{ display: 'flex', gap: '8px', marginTop: '20px', justifyContent: 'flex-end' }}>
                            <button style={btn('var(--c-border)')} onClick={() => setShowProjectForm(false)}><X size={14} />取消</button>
                            <button style={btn('var(--c-accent)')} onClick={handleSaveProject}><Check size={14} />新增</button>
                        </div>
                    </div>
                </div>
            )}
        </>
    )
}