import './tradeForm.css'

export default function TradeMarginToggle({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
    return <div className="trade-form-margin">
        <span className="trade-form-margin__label" aria-hidden="true">融資</span>
        <button type="button" role="switch" aria-label="融資" aria-checked={checked}
            className="trade-form-margin__control" onClick={() => onChange(!checked)}>
            <span className="trade-form-margin__track" aria-hidden="true"><span /></span>
        </button>
    </div>
}
