import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LandingPage } from './LandingPage';

describe('LandingPage', () => {
  it('renders the public landing page and the sign in call to action', () => {
    render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: /Analyze\. Forecast\. Model\. Manage water\./i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open sign in/i })).toHaveAttribute('href', '/login');
    expect(screen.getByText(/Demo access:/i)).toBeInTheDocument();
  });
});
